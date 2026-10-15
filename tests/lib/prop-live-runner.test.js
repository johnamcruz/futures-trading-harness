'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createPropHooks } = require('../../scripts/lib/prop/live-runner');
const prop = require('../../scripts/lib/trading/prop-state');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { main: combineCli } = require('../../scripts/combine');
const { tmpDir, recordBrokerSpecs, TEST_SIZING } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT = 'MNQ';

const COMPONENTS = ['trendy', 'other'];

function bars(n = 200) {
  const t0 = Date.parse('2026-10-07T13:00:00Z');
  return Array.from({ length: n }, (_, k) => {
    const c = 21500 + Math.sin(k / 10) * 20;
    return { t: new Date(t0 + k * 180000).toISOString(), o: c, h: c + 2, l: c - 2, c, v: 100 };
  });
}

function setup({ start = true, contracts = 'micro', specs = true, paper = false, lane = null } = {}) {
  const home = tmpDir();
  if (specs) recordBrokerSpecs(home); // the broker's tick specs, as the translator records them
  const env = {};
  const account = accountNamed(ROOT, 'topstep_50k', {});
  if (start) prop.startAttempt(home, account, new Date('2026-10-05T14:00:00Z'));
  const strategy = {
    name: 'prop_x', valid: true, status: 'active', instruments: ['MNQ', 'NQ'], timeframe: '3m', signal: 'policy', strategies: COMPONENTS,
    account: 'topstep_50k', contracts, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 },
    sizing: TEST_SIZING,
  };
  // Its strategies, as loadStrategies reads them: a policy trades only the active ones (status set per test).
  const components = COMPONENTS.map(name => ({ name, valid: true, errors: [], status: 'active', signal: 'rules', instruments: ['MNQ', 'NQ'], timeframe: '3m' }));
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
  const hooks = createPropHooks({ root: ROOT, env, home, client, accountId: '7', strategies: () => [strategy, ...components], paper, log: m => logs.push(m), journal: () => client.journal, lane });
  return { hooks, home, account, strategy, components, logs, balances, client };
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
  // The state the cycle prompt shows: 0.2 x ($50,250 - $48,000 floor) = $450 for prop_x (the test sizing: cushion_frac 0.2).
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

test('supersede: a verdict skipped for a higher-priority policy becomes the latest the gate reads', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const { hooks, home } = setup();
  await hooks.snapshot(now);
  hooks.screen([{ name: 'trendy', candidate: true, direction: 'long', stopDistance: 10 }], { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const full = prop.latestVerdict(home, 'prop_x', 'MNQ');
  assert.notStrictEqual(full.action, 'skip');
  hooks.supersede(require('../../scripts/lib/lane-cycle').skippedVerdict(full, 'prop_y', now));
  const v = prop.latestVerdict(home, 'prop_x', 'MNQ');
  assert.deepStrictEqual([v.action, v.maxSize, v.bar, v.skippedBy], ['skip', 0, full.bar, 'prop_y']);
});

test('openVerdicts: a policy\'s latest entry verdict while unexpired and unused; never a skip, a used one or an expired one', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const { hooks, client } = setup();
  await hooks.snapshot(now);
  assert.deepStrictEqual(hooks.openVerdicts(now), []);
  hooks.screen([{ name: 'trendy', candidate: true, direction: 'long', stopDistance: 10 }], { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const [open] = hooks.openVerdicts(now);
  assert.strictEqual(open.strategy, 'prop_x');
  assert.ok(open.action === 'full' || open.action === 'half');
  assert.deepStrictEqual(hooks.openVerdicts(new Date(Date.parse(open.expiresAt))), [], 'expired');
  // Used: an entry tagged setup:prop_x went through after it.
  client.journal = [{ ts: new Date(now.getTime() + 1000).toISOString(), kind: 'order_placed', contractId: 'MNQ', text: 'setup:prop_x long', data: { result: { success: true } } }];
  assert.deepStrictEqual(hooks.openVerdicts(now), [], 'used');
  client.journal = [{ ts: new Date(now.getTime() + 1000).toISOString(), kind: 'order_placed', contractId: 'MNQ', text: 'setup:prop_x long', data: { result: { success: false } } }];
  assert.strictEqual(hooks.openVerdicts(now).length, 1, 'a refused order used nothing');
  // Skipped for a higher-priority policy: no longer open.
  hooks.supersede(require('../../scripts/lib/lane-cycle').skippedVerdict(open, 'prop_y', now));
  assert.deepStrictEqual(hooks.openVerdicts(now), []);
});

test('a setup whose stop is too wide for the cushion is skipped with the reason, not silently', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const { hooks, home } = setup();
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
  const { hooks, home } = setup();
  await hooks.snapshot(now);
  const out = hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  assert.strictEqual(out.find(r => r.name === 'trendy').candidate, false, 'its strategies stop being candidates on their own');
  assert.strictEqual(out.find(r => r.name === 'loner'), scan[3], 'other strategies pass through');
  const mine = out.find(r => r.name === 'prop_x');
  assert.strictEqual(mine.component, 'trendy', 'the first in the policy strategy\'s order, not the scan\'s');
  assert.strictEqual(mine.candidate, true);
  const v = prop.latestVerdict(home, 'prop_x', 'MNQ');
  assert.strictEqual(v.action, 'full', 'the sizing says full or skip');
  assert.strictEqual(v.component, 'trendy');
  assert.strictEqual(v.stopTicks, 40);
  // Balance $50,250: cushion $2,250 over the $48,000 floor, budget 0.2 x = $450.
  // A 40-tick stop plus a tick of expected slippage risks 41 x $0.50 = $20.50 + $0.74 fees = $21.24 a contract:
  // 21 micros ($446.04).
  assert.deepStrictEqual([v.maxSize, v.contract], [21, 'MNQ']);
  assert.strictEqual(v.policy, undefined, 'the verdict records no trained policy');
  assert.ok(Date.parse(v.expiresAt) > now.getTime());
  // The runner's contract is the selected leg: MNQ stays 21 micros under contracts auto (never switched to
  // 2 NQ), and NQ selected sizes in minis (NQ: 41 x $5 = $205 + $2.80 fees = $207.80 each: 2).
  for (const [leg, want] of [['MNQ', ['MNQ', 21, 'full']], ['NQ', ['NQ', 2, 'full']]]) {
    for (const contracts of ['auto', 'micro', 'mini']) {
      const auto = setup({ contracts });
      recordBrokerSpecs(auto.home, { roots: ['MNQ', 'NQ'] });
      await auto.hooks.snapshot(now);
      auto.hooks.screen(scan, { symbol: leg, contractId: leg, bars: bars(), now });
      const va = prop.latestVerdict(auto.home, 'prop_x', leg);
      assert.deepStrictEqual([va.contract, va.maxSize, va.action], want, `${leg} selected, contracts ${contracts}: the selected leg`);
    }
  }
  // The tick specs are the broker's: none recorded for the contract (or the family's other one) is a skip saying so.
  for (const roots of [[], ['MNQ']]) {
    const bare = setup({ contracts: 'auto', specs: false });
    if (roots.length) recordBrokerSpecs(bare.home, { roots });
    await bare.hooks.snapshot(now);
    bare.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
    const vb = prop.latestVerdict(bare.home, 'prop_x', 'MNQ');
    assert.deepStrictEqual([vb.action, vb.maxSize], ['skip', 0]);
    assert.match(vb.reason, new RegExp(`no tick specs from the broker for ${roots.length ? 'NQ' : 'MNQ'} yet: call get_contract or search_contracts`));
  }
  // A broker spec unlike the static table (NQ at $0.50, a units mix-up): a skip, never a 10x size.
  const odd = setup({ contracts: 'auto', specs: false });
  recordBrokerSpecs(odd.home, { roots: ['MNQ', 'NQ'], specs: { NQ: { tickValue: 0.5 } } });
  await odd.hooks.snapshot(now);
  odd.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const vo = prop.latestVerdict(odd.home, 'prop_x', 'MNQ');
  assert.deepStrictEqual([vo.action, vo.maxSize], ['skip', 0]);
  assert.match(vo.reason, /^NQ: the broker's tick spec \(0\.25 = \$0\.50\) differs from the static table/);
});

test('a paper strategy stays paper inside a policy: the screen passes over a component that is not active', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  // trendy (first in the policy's order) is paper; other (active) fired too.
  const scan = [
    { name: 'trendy', candidate: true, direction: 'long', stopDistance: 10 },
    { name: 'other', candidate: true, direction: 'short', stopDistance: 10 },
  ];
  const { hooks, home, components } = setup();
  components[0].status = 'paper';
  await hooks.snapshot(now);
  const out = hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const mine = out.find(r => r.name === 'prop_x');
  assert.deepStrictEqual([mine.candidate, mine.component, mine.direction], [true, 'other', 'short'], 'the next active one that fired');
  assert.strictEqual(prop.latestVerdict(home, 'prop_x', 'MNQ').component, 'other');
  const trendy = out.find(r => r.name === 'trendy');
  assert.strictEqual(trendy.candidate, false, 'still owned: never a candidate on its own while the attempt runs');
  assert.match(trendy.note, /^not traded through prop_x: trendy has status "paper": prop_x trades only its active strategies live/);
  assert.strictEqual(out.find(r => r.name === 'other').note, 'traded through prop_x');

  // Only paper components fired: no setup, no verdict, and the policy row says what it passed over.
  const only = setup();
  only.components[0].status = 'paper';
  await only.hooks.snapshot(now);
  const solo = only.hooks.screen([scan[0]], { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const row = solo.find(r => r.name === 'prop_x');
  assert.strictEqual(row.candidate, false);
  assert.strictEqual(row.verdict, undefined);
  assert.match(row.note, /^no setup: passed over trendy \(trendy has status "paper": prop_x trades only its active strategies live/);
  assert.strictEqual(prop.latestVerdict(only.home, 'prop_x', 'MNQ'), null, 'no verdict recorded');
  assert.ok(solo.every(r => !r.candidate), 'nothing to enter');
  assert.match(only.logs.join('\n'), /prop_x has no setup: it passed over trendy/);
  // A component missing from the registry is passed over too (fails closed).
  const gone = setup();
  gone.components.splice(0, 1);
  await gone.hooks.snapshot(now);
  gone.hooks.screen([scan[0]], { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  assert.strictEqual(prop.latestVerdict(gone.home, 'prop_x', 'MNQ'), null);

  // A paper run (no order goes live): a paper component's setup is planned, as a paper run takes any non-disabled policy.
  const paperRun = setup({ paper: true });
  paperRun.components[0].status = 'paper';
  await paperRun.hooks.snapshot(now);
  const p = paperRun.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now }).find(r => r.name === 'prop_x');
  assert.deepStrictEqual([p.candidate, p.component], [true, 'trendy']);
  // ... but never a disabled one.
  const disabled = setup({ paper: true });
  disabled.components[0].status = 'disabled';
  await disabled.hooks.snapshot(now);
  assert.strictEqual(disabled.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now }).find(r => r.name === 'prop_x').component, 'other');
});

test('the prop hooks have no in-trade decision: an open trade is left to the policy strategy\'s exit', () => {
  const { hooks } = setup();
  assert.strictEqual(hooks.position, undefined);
  // supersede records a verdict (a setup skipped for a higher-priority policy) and openVerdicts reads them; recentFills
  // hands the decision history the fills a snapshot read: no in-trade decision either.
  assert.deepStrictEqual(Object.keys(hooks).sort(), ['accounts', 'endOfDay', 'openVerdicts', 'owners', 'recentFills', 'screen', 'snapshot', 'summaries', 'supersede']);
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
  const idle = setup({ start: false });
  const out = idle.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  assert.deepStrictEqual(out, scan);
  assert.strictEqual(prop.latestVerdict(idle.home, 'prop_x', 'MNQ'), null);
  // A paper policy strategy doesn't take setups from active strategies in a live run.
  const paper = setup();
  paper.strategy.status = 'paper';
  await paper.hooks.snapshot(now);
  assert.deepStrictEqual(paper.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now }), scan);
});

test('owners: the strategies an active policy with a running attempt owns on the contract; none otherwise', () => {
  const on = setup();
  const owners = on.hooks.owners({ symbol: 'MNQ', contractId: CONTRACT });
  assert.ok(owners.size > 0 && [...owners.values()].every(v => v === 'prop_x'), JSON.stringify([...owners]));
  assert.strictEqual(on.hooks.owners({ symbol: 'GC', contractId: 'GC' }).size, 0, 'another instrument');
  const off = setup({ start: false });
  assert.strictEqual(off.hooks.owners({ symbol: 'MNQ', contractId: CONTRACT }).size, 0, 'no attempt running');
});

test('screen in another lane (a multi-lane runner): the bar\'s lane decides which policies screen, not the factory\'s', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const lane = more => ({ timeframe: 3, trigger: 'bar', strategies: null, policies: null, ...more });
  // The factory's lane is the 1m one; the bar is the 3m lane's: prop_x (3m) screens and sizes its setup.
  const { hooks, home } = setup({ lane: lane({ timeframe: 1 }) });
  await hooks.snapshot(now);
  const scan = [{ name: 'trendy', candidate: true, direction: 'long', stopDistance: 10 }];
  const out = hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now, lane: lane() });
  assert.strictEqual(out.find(r => r.name === 'prop_x').component, 'trendy');
  assert.ok(prop.latestVerdict(home, 'prop_x', 'MNQ'));
  // And the other way: the factory's 3m lane, a 1m bar: prop_x doesn't screen it (its setup is owned, not traded).
  const other = setup({ lane: lane() });
  await other.hooks.snapshot(now);
  const none = other.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now, lane: lane({ timeframe: 1 }) });
  assert.deepStrictEqual(none, [{ ...scan[0], candidate: false, note: 'not traded: prop_x owns it and is not in this runner\'s lane' }]);
});

test('the runner\'s lane: only its policies screen; a policy outside it still owns its strategies\' setups (never plain setups)', async () => {
  const now = new Date('2026-10-07T23:00:00Z');
  const scan = [{ name: 'trendy', status: 'active', candidate: true, direction: 'long', stopDistance: 10 }];
  const lane = more => ({ timeframe: 3, trigger: 'bar', strategies: null, policies: null, ...more });
  const same = setup({ lane: lane() });
  assert.ok(same.hooks.owners({ symbol: 'MNQ', contractId: CONTRACT }).size > 0, 'its own lane');
  assert.deepStrictEqual(same.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now }).map(r => r.name), ['trendy', 'prop_x']);
  for (const [why, l] of [['another timeframe', lane({ timeframe: 1 })], ['not listed', lane({ policies: ['prop_y'] })]]) {
    const other = setup({ lane: l });
    // Ownership is the policy's, whatever the lane: the owned setup is not a candidate, and no verdict is made for it.
    assert.deepStrictEqual([...other.hooks.owners({ symbol: 'MNQ', contractId: CONTRACT })], [['trendy', 'prop_x'], ['other', 'prop_x']], why);
    const out = other.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
    assert.deepStrictEqual(out, [{ ...scan[0], candidate: false, note: 'not traded: prop_x owns it and is not in this runner\'s lane' }], why);
    assert.strictEqual(prop.latestVerdict(other.home, 'prop_x', 'MNQ'), null, why);
    // Account duties stay per account, whatever the lane: the snapshot and the attempt summary.
    assert.deepStrictEqual(other.hooks.accounts().map(a => a.name), [other.account.name], why);
  }
  // No attempt running: nothing owns the setup, in any lane.
  const idle = setup({ start: false, lane: lane({ policies: ['prop_y'] }) });
  assert.deepStrictEqual(idle.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now }), scan);
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
  // The decision history reuses that read (recentFills): what was read, from when, and when.
  assert.deepStrictEqual(hooks.recentFills(), { sinceMs: Date.parse('2026-10-07T13:30:00Z'), atMs: Date.parse('2026-10-07T14:03:00Z'), fills: client.fills });
  assert.match(prop.combineBlock(home, account.name, t('14:03:30')), /doesn't reconcile: the broker reports \$50250, .* gives \$50208\.76/);
  // A position open: not checked (and not read).
  client.fillsFrom = undefined;
  client.open = [{ contractId: CONTRACT, size: 1, type: 1 }];
  await hooks.snapshot(t('14:06:00'));
  assert.strictEqual(client.fillsFrom, undefined);
  client.open = [];
  // A broker that returns no list: nothing kept for the history (the earlier read stays, with its own time).
  const kept = hooks.recentFills();
  const saved = client.fillsSince;
  let asked = 0;
  client.fillsSince = async () => { asked += 1; return undefined; };
  await hooks.snapshot(t('14:07:30'));
  assert.strictEqual(asked, 1);
  assert.deepStrictEqual(hooks.recentFills(), kept);
  client.fillsSince = saved;
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

test('the attempt line\'s losing streak: prop-state.sessionLossStreak, the one source (the loss streak stop\'s count)', async () => {
  const { hooks, home, account, client } = setup();
  const at = x => new Date(`2026-10-07T${x}Z`);
  await hooks.snapshot(at('14:30:00'));
  assert.deepStrictEqual([hooks.summaries(at('14:30:30'))[0].facts.lossStreak, prop.sessionLossStreak(home, account, at('14:30:30')).count], [0, 0]);
  // Two entries each stopped out: a streak of 2 in this session, the same number the gate's stop reads.
  client.fills = [
    { creationTimestamp: '2026-10-07T14:31:00Z', profitAndLoss: null, fees: 0.37 }, { creationTimestamp: '2026-10-07T14:33:00Z', profitAndLoss: -20, fees: 0.37 },
    { creationTimestamp: '2026-10-07T14:35:00Z', profitAndLoss: null, fees: 0.37 }, { creationTimestamp: '2026-10-07T14:37:00Z', profitAndLoss: -30, fees: 0.37 },
  ];
  client.accountBalance = async () => 50198.52;
  await hooks.snapshot(at('14:40:00'));
  const [sum] = hooks.summaries(at('14:40:30'));
  assert.deepStrictEqual([sum.facts.lossStreak, sum.facts.tradesToday, sum.facts.lossesToday], [2, 2, 2]);
  assert.strictEqual(sum.facts.lossStreak, prop.sessionLossStreak(home, account, at('14:40:30')).count);
  assert.strictEqual(prop.readAttempt(home, account.name).snapshot.state.lossStreak, 2, 'the snapshot\'s state (entryBlock) holds the same count');
  // The next session starts at 0; before its first snapshot the streak is unknown, never yesterday's shown as today's.
  assert.strictEqual(hooks.summaries(new Date('2026-10-08T14:30:00Z'))[0].facts.lossStreak, null);
});
