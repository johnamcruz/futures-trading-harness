'use strict';

// prepareAhead "on" in the runner's prepare-ahead step (scripts/lib/prepare-shadow.js, PR B2): at the close, the confirm
// or the full head trader (atClose: validated against the inputs the cycle starts from, what fired from the real scan),
// the confirm's limits for the cycle's run (the prepare's session, its sealed base, the message after the facts, its
// bound, whether it composed); after the cycle, no shadow confirm, the next bar's prepare (its plan holding the base),
// and the cycle log's prepare field: the mode, the path taken and the close-to-order time.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../scripts/lib/prepare-shadow');
const PA = require('../../scripts/lib/prepare-ahead');
const B = require('../../scripts/lib/trading/briefing');
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { listedReads } = require('../../scripts/lib/learning/setup-moments');
const { validateConfig } = require('../../scripts/lib/autotrader');
const FX = require('../fixtures/momentum-continuation');

const ROOT = path.resolve(__dirname, '..', '..');
const REG = loadStrategies(ROOT, {}).strategies;
const BARS = FX.load();
const FIRE = FX.CENSUS_BG[0][0]; // a short fires at this bar's close
const I = BARS.findIndex(b => b.t === FIRE);
const STEP = 180000;
const cfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], prepareAhead: 'on' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-on-'));
const RT = require('../../scripts/lib/tunables').runner();

function closeAt(k, prev = null) {
  const bars = BARS.slice(0, k + 1);
  const sc = scan(REG, bars, { symbol: 'MNQ' });
  const briefing = B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: sc, prev });
  return { bars, briefing, scan: sc, listed: listedReads(briefing), bar: { t: bars[k].t, c: bars[k].c, contractId: 'MNQ', file: '/bars.json' } };
}
const PREP = closeAt(I - 1);
const FIRED = closeAt(I, PREP.briefing);
const closeMs = c => Date.parse(c.bar.t) + STEP;

/** A session file as Claude Code writes it (each line with its uuid): the prepare's transcript. */
function sessionFile(home, n = 3) {
  const f = path.join(home, 'sessions', `ses-prep-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Array.from({ length: n }, (_x, i) => JSON.stringify({ type: 'user', message: { content: `t${i}` }, uuid: `u${i}`, sessionId: 'p' })).join('\n'));
  return f;
}
/** The prepare's run: one SCENARIO per candidate its prompt lists; its session file the one given. */
function fakeCli(clock, transcript) {
  const runs = [];
  const run = async (_cfg, kind, prompt, limits) => {
    runs.push({ kind, prompt, limits });
    clock.ms += 20000;
    const text = [...prompt.matchAll(/^ {2}- (P\d+) \S+ (long|short) "([^"]+)"/gm)].map((m, j) => `SCENARIO ${j + 1}: ${m[1]} "${m[3]}" → TAKE if the candle meets it | PASS if not; reads: "${m[3]}"; why: the trend`).concat(['STAND DOWN if: a news window', 'INVALID if: a fill', 'PLAN END']).join('\n');
    return { ok: true, timedOut: false, text, sessionId: `ses-${kind}-${runs.length}`, transcript, source: 'startup', usage: null, ms: 20000, denied: [], forbidden: [], gateRefusals: 0, initMs: null };
  };
  return { run, runs };
}
const shadowOf = (home, clock, cli, o = {}) => S.createShadow({ cfg: o.cfg || cfg, root: ROOT, home, runPrepare: cli.run, now: () => new Date(clock.ms), sectionOpts: () => ({ registry: REG }), newsAt: () => ({ inBlackout: false }) });
const acct = clock => ({ id: '7', at: new Date(clock.ms).toISOString(), balance: 50000, positions: [], orders: [], workingOrders: 0 });
/** The prepare after a cycle at close `c` (as the runner calls after()); its cycle log written first. */
async function afterAt(home, c, o = {}) {
  const clock = o.clock || { ms: closeMs(c) + 40000 };
  const cli = o.cli || fakeCli(clock, o.transcript === undefined ? sessionFile(home) : o.transcript);
  const log = path.join(home, 'logs', 'cycles', 'x', `${Date.parse(c.bar.t)}-trade.json`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, JSON.stringify({ result: 'CYCLE RESULT: no-trade - x', context: o.context || {}, ...(o.timing ? { timing: o.timing } : {}) }, null, 2));
  const shadow = shadowOf(home, clock, cli, o);
  const r = await shadow.after({
    symbol: 'MNQ', minutes: 3, bar: c.bar, bars: c.bars, windowBars: null, briefing: c.briefing, factsKey: 'k1', reports: [], scan: c.scan, listed: c.listed,
    result: 'CYCLE RESULT: no-trade - x', cycleLog: log, killSwitch: () => false, accountAfter: async () => acct(clock), phase1KeyOf: () => 'k1', eodMs: null, inSession: () => true,
    ...(o.on !== undefined ? { on: o.on } : {}), ...(o.cycle ? { cycle: o.cycle } : {}),
  });
  return { ...r, cli, clock, log: JSON.parse(fs.readFileSync(log, 'utf8')) };
}
/** At the close `c` (as the runner calls atClose() before the head trader's run). */
function atCloseOf(home, c, o = {}) {
  const clock = { ms: closeMs(c) + 2000 };
  const shadow = shadowOf(home, clock, fakeCli(clock, null), o);
  return shadow.atClose({ symbol: 'MNQ', minutes: 3, bar: c.bar, bars: c.bars, briefing: c.briefing, factsKey: o.factsKey || 'k1', reports: [], scan: o.scan || c.scan, listed: o.listed || c.listed, killSwitch: () => Boolean(o.kill), flat: 'flat' in o ? o.flat : true });
}

test('"on": after a cycle, the next bar\'s prepare runs (no shadow confirm); its plan holds the prepare session\'s sealed base; the record says the mode', async () => {
  const home = tmp();
  const transcript = sessionFile(home, 4);
  const r = await afterAt(home, PREP, { transcript, on: { mode: 'on', path: 'no-plan' } });
  assert.deepStrictEqual(r.cli.runs.map(x => x.kind), ['prepare'], 'only the prepare: the confirm was the cycle\'s own run');
  const plan = PA.readPlan(home, 'MNQ', FIRE);
  assert.ok(plan);
  assert.deepStrictEqual(plan.base.uuids, ['u0', 'u1', 'u2', 'u3']);
  assert.strictEqual(plan.base.transcript, transcript);
  assert.strictEqual(r.log.prepare.mode, 'on');
  assert.strictEqual(r.log.prepare.on.path, 'no-plan');
  assert.strictEqual(r.log.prepare.made.outcome, 'done');
  assert.ok(!('shadow' in r.log.prepare));
});

test('"on" at the plan\'s close, valid and matched: the confirm\'s limits: the prepare\'s session, its plan record as the base, the message after the facts, its bound; composed() says whether a compose came after', async () => {
  const home = tmp();
  await afterAt(home, PREP);
  const plan = PA.readPlan(home, 'MNQ', FIRE);
  const a = atCloseOf(home, FIRED);
  assert.strictEqual(a.record.path, 'confirm', JSON.stringify(a.record));
  assert.strictEqual(a.record.mode, 'on');
  assert.strictEqual(a.record.planId, plan.id);
  assert.deepStrictEqual(a.record.match, { k: 1, id: 'P1', read: 'momentum_continuation fired down', side: 'short' });
  assert.strictEqual(a.confirm.session, plan.session.id);
  assert.strictEqual(a.confirm.base, PA.planFile(home, 'MNQ', FIRE));
  assert.strictEqual(a.confirm.timeoutMs, RT.prepare.confirmMs);
  // What else fired at this close (the real scan: the 15m reactions here) is said, outside the plan.
  const unplanned = PA.matchScenario(plan, a.record.fired).unplanned;
  assert.ok(unplanned.length > 0);
  assert.strictEqual(a.confirm.suffix, PA.confirmSuffix({ scenario: plan.scenarios[0], unplanned }));
  // composed(): a compose record on this bar after the check (the compose_check the confirm makes), none before.
  assert.strictEqual(a.confirm.composed(), false);
  // Another bar's record is no compose of this close's.
  TL.appendRecord(home, { id: 'r0', at: new Date(closeMs(PREP) + 5000).toISOString(), root: 'MNQ', symbol: 'MNQ', bar: PREP.bar.t, side: 'short', ok: true, reads: [], plan: null });
  assert.strictEqual(a.confirm.composed(), false);
  TL.appendRecord(home, { id: 'r1', at: new Date(closeMs(FIRED) + 5000).toISOString(), root: 'MNQ', symbol: 'MNQ', bar: FIRED.bar.t, side: 'short', ok: true, reads: [], plan: null });
  assert.strictEqual(a.confirm.composed(), true);
});

test('"on" at the close, every fallback row: the full head trader runs (no confirm limits), the record saying why', async () => {
  const home = tmp();
  // No plan at all.
  assert.deepStrictEqual([atCloseOf(home, FIRED).record.path, atCloseOf(home, FIRED).confirm], ['no-plan', undefined]);
  await afterAt(home, PREP);
  const rows = [
    ['kill-switch', { kill: true }],
    ['not-flat', { flat: false }],
    ['void', { factsKey: 'k2' }, 'facts'],
    ['outside', { scan: [], listed: ['15m rejected vwap down'] }],
    ['nothing-fired', { scan: [], listed: [] }],
  ];
  for (const [p, o, reason] of rows) {
    const a = atCloseOf(home, FIRED, o);
    assert.strictEqual(a.record.path, p, JSON.stringify(a.record));
    if (reason) assert.strictEqual(a.record.reason, reason);
    assert.strictEqual(a.confirm, undefined, p);
  }
  assert.deepStrictEqual(atCloseOf(home, FIRED, { scan: [], listed: ['15m rejected vwap down'] }).record.unplannedKinds, { vwap: 1 });
  // A plan without a base (the prepare's session file unreadable): never a confirm.
  const home2 = tmp();
  await afterAt(home2, PREP, { transcript: null });
  assert.ok(!PA.readPlan(home2, 'MNQ', FIRE).base);
  assert.strictEqual(atCloseOf(home2, FIRED).record.path, 'no-base');
  // The prepare session's file gone before the close: void.
  const home3 = tmp();
  const t3 = sessionFile(home3);
  await afterAt(home3, PREP, { transcript: t3 });
  fs.rmSync(t3);
  assert.deepStrictEqual([atCloseOf(home3, FIRED).record.path, atCloseOf(home3, FIRED).record.reason], ['void', 'session-missing']);
});

test('"on" after the cycle: the record adds the confirm\'s outcome, the close-to-order time, whether the desk ran or was cached, the late refusals; after a failed cycle the record is written and no prepare runs', async () => {
  const home = tmp();
  const on = { mode: 'on', path: 'confirm', planId: 'p' };
  const r = await afterAt(home, FIRED, { on, cycle: { ok: true, confirm: { outcome: 'done', ms: 7000, fellBack: false, late: ['chased-entry'] } }, timing: { latencyMs: { order: 21000 } }, context: { desk: { ms: 25000 } } });
  assert.deepStrictEqual(r.log.prepare.on, { ...on, confirm: { outcome: 'done', ms: 7000, fellBack: false }, late: ['chased-entry'], closeToOrderMs: 21000, desk: 'ran' });
  const cached = await afterAt(tmp(), FIRED, { on, cycle: { ok: true }, timing: { latencyMs: { order: null } }, context: { cachedRoles: ['risk-manager'] } });
  assert.strictEqual(cached.log.prepare.on.desk, 'cached');
  assert.strictEqual(cached.log.prepare.on.closeToOrderMs, null);
  const failed = await afterAt(tmp(), FIRED, { on: { mode: 'on', path: 'no-plan' }, cycle: { ok: false } });
  assert.deepStrictEqual(failed.cli.runs, [], 'no prepare after a failed cycle');
  assert.deepStrictEqual(failed.log.prepare.made, { outcome: 'skipped', why: 'cycle-failed' });
  assert.strictEqual(failed.log.prepare.on.path, 'no-plan');
});

test('shadow mode is unchanged by "on": its record says its mode; no atClose path is offered in shadow', async () => {
  const home = tmp();
  const scfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], prepareAhead: 'shadow' });
  const r = await afterAt(home, PREP, { cfg: scfg });
  assert.strictEqual(r.log.prepare.mode, 'shadow');
  assert.ok('shadow' in r.log.prepare && !('on' in r.log.prepare));
  const clock = { ms: 0 };
  assert.strictEqual(shadowOf(home, clock, fakeCli(clock, null), { cfg: scfg }).mode, 'shadow');
  assert.throws(() => shadowOf(home, clock, fakeCli(clock, null), { cfg: scfg }).atClose({}), /"on" only/);
});
