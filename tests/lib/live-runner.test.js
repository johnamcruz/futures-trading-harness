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
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT = 'CON.F.US.MNQ.Z26';

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
    gate: { minPassRate: 0.4, maxBlows: 0 }, validated: true, oos: { attempts: 20, passed: 10, blown: 0, passRate: 0.5, months: { '2026-01': { attempts: 10, blown: 0 }, '2026-02': { attempts: 10, blown: 0 } } },
  };
}

function bars(n = 200) {
  const t0 = Date.parse('2026-10-07T13:00:00Z');
  return Array.from({ length: n }, (_, k) => {
    const c = 21500 + Math.sin(k / 10) * 20;
    return { t: new Date(t0 + k * 180000).toISOString(), o: c, h: c + 2, l: c - 2, c, v: 100 };
  });
}

function setup({ policy = 'always_2', start = true, models = {}, contracts = 'micro' } = {}) {
  const home = tmpDir();
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
  };
  const hooks = createPropHooks({ root: ROOT, env, home, client, accountId: '7', strategies: () => [strategy], log: m => logs.push(m) });
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
  // A catch-up end of day after the 18:00 ET open records the day it closes, not today.
  await hooks.endOfDay(new Date('2026-10-08T22:30:00Z'), '2026-10-08');
  assert.deepStrictEqual(prop.readAttempt(home, account.name).days.map(d => d.day), ['2026-10-07', '2026-10-08']);
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
  client.open = [{ contractId: 'CON.F.US.GCE.Z26', size: 1, type: 1 }];
  await assert.rejects(() => hooks.endOfDay(new Date('2026-10-07T19:50:00Z'), '2026-10-07'), /still open \(CON.F.US.GCE.Z26\)/);
  const now = new Date('2026-10-07T14:30:00Z');
  await hooks.snapshot(now);
  assert.match(prop.combineBlock(home, account.name, now), /a position is open on the account \(CON.F.US.GCE.Z26\).*close it to trade the attempt/);
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
  // contracts auto: 21 micros is 2 minis (NQ: $200 + $2.80 fees = $202.80 each).
  const auto = setup({ policy: null, contracts: 'auto' });
  await auto.hooks.snapshot(now);
  auto.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
  const va = prop.latestVerdict(auto.home, 'prop_x', 'NQ');
  assert.deepStrictEqual([va.contract, va.maxSize, va.policy, va.action], ['NQ', 2, null, 'full'], 'no bundle: the setup as sized');
  // A bundle trained for another policy strategy, account, sizing, or contract mode never decides.
  for (const [meta, why] of [[{ strategy: 'other_prop' }, /trained for other_prop/], [{ components: ['trendy'] }, /different observation/], [{ account: 'topstep_100k' }, /account topstep_100k/],
    [{ sizing: { cushion_frac: 0.5 } }, /sizing/], [{ symbol: 'MES' }, /trained on MES/], [{ contracts: 'auto' }, /contracts: auto/]]) {
    const other = setup({ policy: 'b', models: { b: { ...bundle(2), ...meta } } });
    await other.hooks.snapshot(now);
    other.hooks.screen(scan, { symbol: 'MNQ', contractId: CONTRACT, bars: bars(), now });
    assert.match(prop.latestVerdict(other.home, 'prop_x', 'MNQ').reason, why);
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
