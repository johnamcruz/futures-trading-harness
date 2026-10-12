'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createPropHooks } = require('../../scripts/lib/rl/live-runner');
const prop = require('../../scripts/lib/trading/prop-state');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { observationFields } = require('../../scripts/lib/rl/observation');
const { ACTIONS } = require('../../scripts/lib/rl/challenge-env');
const { BUNDLE_FORMAT, BUNDLE_VERSION } = require('../../scripts/lib/rl/policy-bundle');
const { main: combineCli } = require('../../scripts/combine');
const { tmpDir, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT = 'MNQ';

const COMPONENTS = ['trendy', 'other'];
const FIELDS = observationFields(COMPONENTS);
const DIM = FIELDS.length;

/** A validated bundle for prop_x whose network always picks `action` (0 skip / 1 half / 2 full; position: 0 hold / 1 close). */
function bundle(action) {
  const sizes = [DIM, 3];
  const b = [0, 0, 0];
  b[action] = 10;
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, name: `always_${action}`, strategy: 'prop_x', components: COMPONENTS, strategies: COMPONENTS,
    account: 'topstep_50k', symbol: 'MNQ', timeframe: 3, sizing: null, contracts: 'micro', exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, obsFields: FIELDS, profile: require('../../scripts/lib/trading/volume-profile').DEFAULTS, actions: ACTIONS,
    network: { obsDim: DIM, actionN: 3, hidden: [], actor: { sizes, layers: [{ W: new Array(3 * DIM).fill(0), b }] }, normalizer: { mean: new Array(DIM).fill(0), var: new Array(DIM).fill(1), count: 1, clip: 5 } },
    gate: { minPassRate: 0.4, maxBlows: 0 }, validated: true, engine: { gate: true, slippageTicks: 1, fill: 'next-open' }, oos: { attempts: 20, passed: 10, blown: 0, passRate: 0.5, months: { '2026-01': { attempts: 10, blown: 0 }, '2026-02': { attempts: 10, blown: 0 } } },
  };
}

function bars(n = 200) {
  const t0 = Date.parse('2026-10-07T13:00:00Z');
  return Array.from({ length: n }, (_, k) => {
    const c = 21500 + Math.sin(k / 10) * 20;
    return { t: new Date(t0 + k * 180000).toISOString(), o: c, h: c + 2, l: c - 2, c, v: 100 };
  });
}

function setup({ policy = 'always_2', start = true, models = {}, contracts = 'micro', specs = true } = {}) {
  const home = tmpDir();
  if (specs) recordBrokerSpecs(home); // the broker's tick specs, as the translator records them
  const modelsDir = tmpDir();
  for (const [name, b] of Object.entries(models)) fs.writeFileSync(path.join(modelsDir, `${name}.json`), JSON.stringify(b));
  const env = { FTH_MODELS_DIRS: modelsDir };
  const account = accountNamed(ROOT, 'topstep_50k', {});
  if (start) prop.startAttempt(home, account, new Date('2026-10-05T14:00:00Z'));
  const strategy = {
    name: 'prop_x', valid: true, status: 'active', instruments: ['MNQ', 'NQ'], timeframe: '3m', signal: 'policy', strategies: COMPONENTS,
    account: 'topstep_50k', contracts, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, policy: policy ? { bundle: policy } : undefined,
  };
  const logs = [];
  const balances = [];
  const client = {
    open: [],
    async accountBalance(id) { balances.push(id); return 50250; },
    async accountState() { return { positions: client.open, orders: [] }; },
    fills: [],
    journal: [],
    async fillsSince(id, start) { client.fillsFrom = start.toISOString(); return client.fills.filter(f => Date.parse(f.creationTimestamp) >= start.getTime()); },
  };
  const hooks = createPropHooks({ root: ROOT, env, home, client, accountId: '7', strategies: () => [strategy], log: m => logs.push(m), journal: () => client.journal });
  return { hooks, home, account, strategy, logs, balances, client };
}

test('snapshots and end-of-day balances go to the attempt the gate reads', async () => {
  const { hooks, home, account, balances, client } = setup();
  // The closing balance is read only when flat.
  client.open = [{ contractId: CONTRACT, size: 1, type: 1 }];
  await assert.rejects(() => hooks.endOfDay(new Date('2026-10-07T19:50:00Z'), '2026-10-07'), /still open/);
  await hooks.snapshot(new Date('2026-10-07T14:29:00Z'));
  assert.match(prop.combineBlock(home, account.name, new Date('2026-10-07T14:29:30Z')), /one position at a time/);
  client.open = [];
  assert.deepStrictEqual(hooks.accounts().map(a => a.name), ['topstep_50k']);
  const now = new Date('2026-10-07T14:30:00Z');
  await hooks.snapshot(now);
  assert.deepStrictEqual(balances, ['7', '7']);
  assert.strictEqual(prop.combineBlock(home, account.name, now), null);
  assert.strictEqual(prop.readAttempt(home, account.name).snapshot.balance, 50250);
  // The state the cycle prompt shows: 0.2 x ($50,250 - $48,000 floor) = $450 for prop_x (default sizing).
  const [sum] = hooks.summaries(now);
  assert.deepStrictEqual({ account: sum.account, balance: sum.balance, floor: sum.floor, cushion: sum.cushion, dayPnl: sum.dayPnl, budgets: sum.budgets, entryBlock: sum.entryBlock },
    { account: 'topstep_50k', balance: 50250, floor: 48000, cushion: 2250, dayPnl: 250, budgets: [{ strategy: 'prop_x', budgetUsd: 450 }], entryBlock: null });
  assert.deepStrictEqual(setup({ start: false }).hooks.summaries(now), [], 'no attempt, no state');
  assert.strictEqual(sum.asOf, now.toISOString(), 'built from the snapshot taken now');
  // A balance just read wins over the snapshot, and says so.
  const later = new Date('2026-10-07T14:33:00Z');
  const [fresh] = hooks.summaries(later, 50400);
  assert.deepStrictEqual([fresh.balance, fresh.cushion, fresh.dayPnl, fresh.asOf, fresh.snapshotAt, fresh.budgets[0].budgetUsd], [50400, 2400, 400, later.toISOString(), now.toISOString(), 480]);
  // Without a read, the snapshot's own time.
  assert.strictEqual(hooks.summaries(later)[0].asOf, now.toISOString());
  // Started but never snapshotted: no numbers, only the gate's block.
  const bare = setup();
  const [unread] = bare.hooks.summaries(now);
  assert.deepStrictEqual({ account: unread.account, noBalance: unread.noBalance, balance: unread.balance }, { account: 'topstep_50k', noBalance: true, balance: undefined });
  assert.match(unread.entryBlock, /snapshot is missing/);
  await hooks.endOfDay(new Date('2026-10-07T19:50:00Z'), '2026-10-07');
  await hooks.endOfDay(new Date('2026-10-07T19:55:00Z'), '2026-10-07');
  assert.deepStrictEqual(prop.readAttempt(home, account.name).days, [{ day: '2026-10-07', balance: 50250, pnl: 250 }]);
  // A catch-up end of day after the 18:00 ET open records the day it closes, not today, at that day's balance:
  // what the fills since it ended (the catch-up's own close at -$150, fees $0.74) made is taken back out.
  client.fills = [{ creationTimestamp: '2026-10-08T22:05:00Z', profitAndLoss: -150, fees: 0.74 }, { creationTimestamp: '2026-10-08T19:00:00Z', profitAndLoss: 40, fees: 0.74 }];
  await hooks.endOfDay(new Date('2026-10-08T22:30:00Z'), '2026-10-08');
  assert.strictEqual(client.fillsFrom, '2026-10-08T22:00:00.000Z', 'the fills since 18:00 ET that evening');
  assert.deepStrictEqual(prop.readAttempt(home, account.name).days.map(d => [d.day, d.balance]), [['2026-10-07', 50250], ['2026-10-08', 50400.74]]);
  // No attempt: nothing is written, the gate keeps refusing, and the log says how to start one.
  const none = setup({ start: false });
  await none.hooks.snapshot(now);
  assert.strictEqual(prop.readAttempt(none.home, 'topstep_50k'), null);
  assert.match(none.logs.join('\n'), /combine\.js start --account topstep_50k/);
});

test('no end-of-day or position deadlock: a day before the attempt is not an error, and open positions are named', async () => {
  const { hooks, home, account, client } = setup();
  await hooks.endOfDay(new Date('2026-10-02T20:00:00Z'), '2026-10-02'); // before the attempt started (2026-10-05)
  assert.deepStrictEqual(prop.readAttempt(home, account.name).days, []);
  client.open = [{ contractId: 'GC', size: 1, type: 1 }];
  await assert.rejects(() => hooks.endOfDay(new Date('2026-10-07T19:50:00Z'), '2026-10-07'), /still open \(GC\)/);
  const now = new Date('2026-10-07T14:30:00Z');
  await hooks.snapshot(now);
  assert.match(prop.combineBlock(home, account.name, now), /a position is open on the account \(GC\).*close it to trade the attempt/);
});

test('a setup whose stop is too wide for the cushion is skipped with the reason, not silently', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const { hooks, home } = setup({ policy: null });
  await hooks.snapshot(now);
  // A 1,000-point stop risks $2,000 a micro, far over the $450 budget.
  hooks.screen([{ name: 'trendy', candidate: true, direction: 'long', stopDistance: 1000 }], { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const v = prop.latestVerdict(home, 'prop_x', 'MNQ');
  assert.strictEqual(v.action, 'skip');
  assert.match(v.reason, /size budget \(\$450\) is below one contract at this stop; with a cushion of \$2250 the attempt can only trade setups with tighter stops/);
});

test('a policy strategy screens its strategies\' setups: the first that fired, sized in micros or minis; the verdict is recorded', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const scan = [
    { name: 'other', candidate: true, direction: 'short', stopDistance: 5 },
    { name: 'trendy', candidate: true, direction: 'long', stopDistance: 10 },
    { name: 'prop_x', candidate: false, signal: 'policy' },
    { name: 'loner', candidate: true, direction: 'long', stopDistance: 4 },
  ];
  for (const [action, maxOk] of [[2, true], [1, true], [0, false]]) {
    const { hooks, home } = setup({ policy: `always_${action}`, models: { [`always_${action}`]: bundle(action) } });
    await hooks.snapshot(now);
    const out = hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
    assert.strictEqual(out.find(r => r.name === 'trendy').candidate, false, 'its strategies stop being candidates on their own');
    assert.strictEqual(out.find(r => r.name === 'loner'), scan[3], 'other strategies pass through');
    const mine = out.find(r => r.name === 'prop_x');
    assert.strictEqual(mine.component, 'trendy', 'the first in the policy strategy\'s order, not the scan\'s');
    assert.strictEqual(mine.candidate, maxOk);
    const v = prop.latestVerdict(home, 'prop_x', 'MNQ');
    assert.strictEqual(v.action, ACTIONS.setup[action]);
    assert.strictEqual(v.component, 'trendy');
    assert.strictEqual(v.stopTicks, 40);
    // Balance $50,250: cushion $2,250 over the $48,000 floor, budget 0.2 x = $450.
    // A 40-tick stop risks $20 + $0.74 fees = $20.74 a contract: 21 micros; half: 10.
    assert.strictEqual(v.maxSize, [0, 10, 21][action]);
    if (action) assert.strictEqual(v.contract, 'MNQ');
    assert.ok(Date.parse(v.expiresAt) > now.getTime());
  }
  // The runner's contract is the selected leg: MNQ stays 21 micros under contracts auto (never switched to
  // 2 NQ), and NQ selected sizes in minis (NQ: $200 + $2.80 fees = $202.80 each: 2).
  for (const [leg, want] of [['MNQ', ['MNQ', 21, null, 'full']], ['NQ', ['NQ', 2, null, 'full']]]) {
    for (const contracts of ['auto', 'micro', 'mini']) {
      const auto = setup({ policy: null, contracts });
      recordBrokerSpecs(auto.home, { roots: ['MNQ', 'NQ'] });
      await auto.hooks.snapshot(now);
      auto.hooks.screen(scan, { symbol: leg, contractId: leg, bars: bars(), now });
      const va = prop.latestVerdict(auto.home, 'prop_x', leg);
      assert.deepStrictEqual([va.contract, va.maxSize, va.policy, va.action], want, `${leg} selected, contracts ${contracts}: the selected leg`);
    }
  }
  // The tick specs are the broker's: none recorded for the contract (or the family's other one) is a skip saying so.
  for (const roots of [[], ['MNQ']]) {
    const bare = setup({ policy: null, contracts: 'auto', specs: false });
    if (roots.length) recordBrokerSpecs(bare.home, { roots });
    await bare.hooks.snapshot(now);
    bare.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
    const vb = prop.latestVerdict(bare.home, 'prop_x', 'MNQ');
    assert.deepStrictEqual([vb.action, vb.maxSize], ['skip', 0]);
    assert.match(vb.reason, new RegExp(`no tick specs from the broker for ${roots.length ? 'NQ' : 'MNQ'} yet: call get_contract or search_contracts`));
  }
  // A broker spec unlike the static table (NQ at $0.50, a units mix-up): a skip, never a 10x size.
  const odd = setup({ policy: null, contracts: 'auto', specs: false });
  recordBrokerSpecs(odd.home, { roots: ['MNQ', 'NQ'], specs: { NQ: { tickValue: 0.5 } } });
  await odd.hooks.snapshot(now);
  odd.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const vo = prop.latestVerdict(odd.home, 'prop_x', 'MNQ');
  assert.deepStrictEqual([vo.action, vo.maxSize], ['skip', 0]);
  assert.match(vo.reason, /^NQ: the broker's tick spec \(0\.25 = \$0\.50\) differs from the static table/);
  // A bundle trained for another policy strategy, account, sizing, or contract mode never decides.
  for (const [meta, why] of [[{ strategy: 'other_prop' }, /trained for other_prop/], [{ components: ['trendy'] }, /different observation/], [{ account: 'topstep_100k' }, /account topstep_100k/],
    [{ sizing: { cushion_frac: 0.5 } }, /sizing/], [{ symbol: 'MES' }, /trained on MES/], [{ contracts: 'auto' }, /contracts: auto/]]) {
    const other = setup({ policy: 'b', models: { b: { ...bundle(2), ...meta } } });
    await other.hooks.snapshot(now);
    other.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
    assert.match(prop.latestVerdict(other.home, 'prop_x', 'MNQ').reason, why);
  }
  // Live sizes the selected leg only: a bundle trained on one leg decides only on that leg (minis here: NQ, not MNQ).
  for (const [leg, why] of [['MNQ', /policy b was trained on minis only \(contracts: mini\), and the selected contract MNQ is the micro: select the NQ, or retrain/], ['NQ', null]]) {
    const m = setup({ policy: 'b', contracts: 'mini', models: { b: { ...bundle(2), contracts: 'mini' } } });
    recordBrokerSpecs(m.home, { roots: ['MNQ', 'NQ'] });
    await m.hooks.snapshot(now);
    m.hooks.screen(scan, { symbol: leg, contractId: leg, bars: bars(), now });
    const vm = prop.latestVerdict(m.home, 'prop_x', leg);
    if (why) assert.match(vm.reason, why, leg);
    else assert.deepStrictEqual([vm.contract, vm.policy, vm.action], ['NQ', 'always_2', 'full'], leg);
  }
  const broken = setup({ policy: 'missing' });
  await broken.hooks.snapshot(now);
  const out = broken.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  assert.strictEqual(out.find(r => r.name === 'prop_x').candidate, false);
  assert.match(prop.latestVerdict(broken.home, 'prop_x', 'MNQ').reason, /not found/);
  const cand = setup({ policy: 'cand', models: { cand: { ...bundle(2), validated: false } } });
  await cand.hooks.snapshot(now);
  cand.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  assert.match(prop.latestVerdict(cand.home, 'prop_x', 'MNQ').reason, /not validated/);
});

test('in a trade past the ratchet the policy says hold or close, from the verdict the trade was entered on', async () => {
  const pos = { sign: 1, entry: 21500, risk: 10, size: 1, peakR: 2.5, troughR: -0.3, barsHeld: 6 };
  const enter = async h => {
    await h.hooks.snapshot(new Date('2026-10-07T22:59:00Z'));
    h.hooks.screen([{ name: 'trendy', candidate: true, direction: 'long', stopDistance: 10 }], { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now: new Date('2026-10-07T23:00:00Z') });
  };
  const close = setup({ policy: 'always_1', models: { always_1: bundle(1) } });
  // No verdict for this trade yet: the trail manages it alone.
  assert.strictEqual(close.hooks.position({ strategy: close.strategy, contractId: CONTRACT, bars: bars(), pos }), null);
  await enter(close);
  assert.strictEqual(close.hooks.position({ strategy: close.strategy, contractId: CONTRACT, bars: bars(), pos }), 'close');
  const hold = setup({ policy: 'always_2', models: { always_2: bundle(2) } });
  await enter(hold);
  assert.strictEqual(hold.hooks.position({ strategy: hold.strategy, contractId: CONTRACT, bars: bars(), pos }), 'hold');
  const none = setup({ policy: 'missing' });
  assert.strictEqual(none.hooks.position({ strategy: none.strategy, contractId: CONTRACT, bars: bars(), pos }), null);
  assert.strictEqual(none.hooks.position({ strategy: { ...none.strategy, policy: undefined }, contractId: CONTRACT, bars: bars(), pos }), null);
});

test('combine CLI: start an attempt and read its status', () => {
  const home = tmpDir();
  const old = process.env.FTH_HOME;
  process.env.FTH_HOME = home;
  try {
    let out = '';
    combineCli(['start', '--account', 'topstep_100k'], s => { out += s; });
    assert.match(out, /started a topstep_100k attempt: \$6000 target, \$3000 max loss/);
    out = '';
    combineCli(['status', '--json'], s => { out += s; });
    const [row] = JSON.parse(out).attempts;
    assert.strictEqual(row.account, 'topstep_100k');
    assert.strictEqual(row.floor, 97000);
    assert.match(row.entryBlock, /snapshot is missing/);
    assert.throws(() => combineCli(['start']), /usage/);
  } finally {
    if (old === undefined) delete process.env.FTH_HOME;
    else process.env.FTH_HOME = old;
  }
});

test('a policy strategy owns its strategies\' setups only while it is active and an attempt runs', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const scan = [{ name: 'trendy', status: 'active', candidate: true, direction: 'long', stopDistance: 10 }];
  // No attempt: the rules strategy trades as before, and no verdict is recorded.
  const idle = setup({ policy: null, start: false });
  const out = idle.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  assert.deepStrictEqual(out, scan);
  assert.strictEqual(prop.latestVerdict(idle.home, 'prop_x', 'MNQ'), null);
  // A paper policy strategy doesn't take setups from active strategies in a live run.
  const paper = setup({ policy: null });
  paper.strategy.status = 'paper';
  await paper.hooks.snapshot(now);
  assert.deepStrictEqual(paper.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now }), scan);
  // A trained exit is part of the contract: an edited exit block refuses the bundle.
  const edited = setup({ policy: 'always_2', models: { always_2: { ...bundle(2), exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } } } });
  edited.strategy.exit = { trail_activate_r: 1, trail_giveback_r: 0.5 };
  await edited.hooks.snapshot(now);
  edited.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  assert.match(prop.latestVerdict(edited.home, 'prop_x', 'MNQ').reason, /trained with exit/);
});

test('owners: the strategies an active policy with a running attempt owns on the contract; none otherwise', () => {
  const on = setup({ policy: null });
  const owners = on.hooks.owners({ symbol: 'MNQ', contractId: CONTRACT });
  assert.ok(owners.size > 0 && [...owners.values()].every(v => v === 'prop_x'), JSON.stringify([...owners]));
  assert.strictEqual(on.hooks.owners({ symbol: 'GC', contractId: 'GC' }).size, 0, 'another instrument');
  const off = setup({ policy: null, start: false });
  assert.strictEqual(off.hooks.owners({ symbol: 'MNQ', contractId: CONTRACT }).size, 0, 'no attempt running');
});

test('each bar the snapshot checks the broker\'s balance against its fills since the day\'s anchor; a broker that can\'t list them refuses entries', async () => {
  const { hooks, home, account, client } = setup();
  const t = s => new Date(`2026-10-07T${s}Z`);
  await hooks.snapshot(t('13:30:00'));
  assert.strictEqual(client.fillsFrom, undefined, 'the first snapshot of the day anchors: no fills to read yet');
  // The broker shows $50,250 but its fills since the anchor made -$41.24: entries stop.
  client.fills = [{ creationTimestamp: '2026-10-07T14:00:00Z', profitAndLoss: null, fees: 0.37 }, { creationTimestamp: '2026-10-07T14:02:00Z', profitAndLoss: -40.5, fees: 0.37 }];
  await hooks.snapshot(t('14:03:00'));
  assert.strictEqual(client.fillsFrom, '2026-10-07T13:30:00.000Z', 'the fills since the anchor');
  assert.match(prop.combineBlock(home, account.name, t('14:03:30')), /doesn't reconcile: the broker reports \$50250, .* gives \$50208\.76/);
  // A position open: not checked (and not read).
  client.fillsFrom = undefined;
  client.open = [{ contractId: CONTRACT, size: 1, type: 1 }];
  await hooks.snapshot(t('14:06:00'));
  assert.strictEqual(client.fillsFrom, undefined);
  client.open = [];
  // search_trades fails: entries wait, the runner goes on.
  client.fillsSince = async () => { throw new Error('search_trades: 503'); };
  await hooks.snapshot(t('14:09:00'));
  assert.match(prop.combineBlock(home, account.name, t('14:09:30')), /couldn't be checked against the broker's fills \(search_trades: 503\)/);
});

test('the fills are read only when something moved: an unchanged, reconciled account costs no broker call; a position open never anchors', async () => {
  const { hooks, home, account, client } = setup();
  const t = s => new Date(`2026-10-07T${s}Z`);
  let calls = 0;
  const list = client.fillsSince.bind(client);
  client.fillsSince = async (id, start) => { calls += 1; return list(id, start); };
  // A position open at the day's first snapshot: no anchor yet (a fill during the read would count twice).
  client.open = [{ contractId: CONTRACT, size: 1, type: 1 }];
  await hooks.snapshot(t('13:30:00'));
  assert.strictEqual(prop.readAttempt(home, account.name).anchor, null);
  client.open = [];
  await hooks.snapshot(t('13:33:00'));
  assert.strictEqual(prop.readAttempt(home, account.name).anchor.at, '2026-10-07T13:33:00.000Z', 'the first flat snapshot anchors');
  assert.strictEqual(calls, 0);
  // The first check after the anchor reads the fills once; then nothing moved: no call, the check carries forward.
  await hooks.snapshot(t('13:36:00'));
  await hooks.snapshot(t('13:39:00'));
  await hooks.snapshot(t('13:42:00'));
  assert.strictEqual(calls, 1);
  assert.strictEqual(prop.combineBlock(home, account.name, t('13:42:30')), null);
  // A position opened and closed: read again when flat.
  client.open = [{ contractId: CONTRACT, size: 1, type: 1 }];
  await hooks.snapshot(t('13:45:00'));
  client.open = [];
  await hooks.snapshot(t('13:48:00'));
  assert.strictEqual(calls, 2);
  // The balance moved with no fill to explain it: read, mismatch, and read again every bar until it reconciles.
  client.accountBalance = async () => 50200;
  await hooks.snapshot(t('13:51:00'));
  await hooks.snapshot(t('13:54:00'));
  assert.strictEqual(calls, 4);
  assert.match(prop.combineBlock(home, account.name, t('13:54:30')), /doesn't reconcile/);
  // A broker that rejects with no Error still refuses entries.
  client.fillsSince = async () => { throw 'gateway down'; };
  await hooks.snapshot(t('13:57:00'));
  assert.match(prop.combineBlock(home, account.name, t('13:57:30')), /couldn't be checked .*gateway down/);
});

test('a round trip between two flat snapshots at the same balance is read anyway: our own order since the last snapshot counts as a change', async () => {
  const { hooks, home, account, client } = setup();
  const t = s => new Date(`2026-10-07T${s}Z`);
  let calls = 0;
  const list = client.fillsSince.bind(client);
  client.fillsSince = async (id, start) => { calls += 1; return list(id, start); };
  await hooks.snapshot(t('13:33:00'));
  await hooks.snapshot(t('13:36:00'));
  assert.strictEqual(calls, 1, 'reconciled at $50,250');
  // The cycle after the 13:36 snapshot enters and is stopped out before 13:39; the broker hasn't booked the loss.
  const placed = (ts, text) => ({ ts, kind: 'order_placed', contractId: CONTRACT, text, data: { result: { success: true } } });
  client.journal = [placed('2026-10-07T13:37:00Z', 'setup:prop_x long'), placed('2026-10-07T13:37:01Z', '[protect] stop')];
  client.fills = [{ creationTimestamp: '2026-10-07T13:37:00Z', profitAndLoss: null, fees: 0.37 }, { creationTimestamp: '2026-10-07T13:38:30Z', profitAndLoss: -40.5, fees: 0.37 }];
  await hooks.snapshot(t('13:39:00'));
  assert.strictEqual(calls, 2, 'read despite the same balance and flat both times');
  assert.match(prop.combineBlock(home, account.name, t('13:39:30')), /doesn't reconcile: the broker reports \$50250, .* gives \$50208\.76/);
  // A journal that can't be read counts as moved too.
  client.accountBalance = async () => 50208.76;
  await hooks.snapshot(t('13:42:00'));
  assert.strictEqual(prop.combineBlock(home, account.name, t('13:42:30')), null);
  const before = calls;
  client.journal = null;
  const broken = createPropHooks({ root: ROOT, env: {}, home, client, accountId: '7', strategies: () => [{ ...setup().strategy }], journal: () => { throw new Error('EACCES'); } });
  await broken.snapshot(t('13:45:00'));
  assert.strictEqual(calls, before + 1);
});
