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
const cfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], prepareAhead: 'on', headSkillsInPrompt: true });
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
  fs.writeFileSync(log, JSON.stringify({ result: 'CYCLE RESULT: no-trade - x', context: o.context || {}, ...(o.timing ? { timing: o.timing } : {}), ...(o.entry ? { entry: o.entry } : {}) }, null, 2));
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
  const m = PA.matchScenario(plan, a.record.fired);
  assert.ok(m.unplanned.length > 0);
  // PR C3: the momentum fire and the three standing 15m reactions all fired here: each scenario named, in plan order.
  assert.deepStrictEqual(m.matches.map(x => x.k), [1, 2, 3, 4]);
  assert.strictEqual(a.confirm.suffix, PA.confirmSuffix({ matched: PA.matchedScenarios(plan, m), unplanned: m.unplanned }));
  // composed(): a compose record on this bar after the check (the compose_check the confirm makes), none before.
  assert.strictEqual(a.confirm.composed(), false);
  // Another bar's record is no compose of this close's.
  TL.appendRecord(home, { id: 'r0', at: new Date(closeMs(PREP) + 5000).toISOString(), root: 'MNQ', symbol: 'MNQ', bar: PREP.bar.t, side: 'short', ok: true, reads: [], plan: null });
  assert.strictEqual(a.confirm.composed(), false);
  TL.appendRecord(home, { id: 'r1', at: new Date(closeMs(FIRED) + 5000).toISOString(), root: 'MNQ', symbol: 'MNQ', bar: FIRED.bar.t, side: 'short', ok: true, reads: [], plan: null });
  assert.strictEqual(a.confirm.composed(), true);
});

test('"on" at the close: the confirm\'s message carries the standing line for each MATCHED standing scenario (PR C3: the momentum primary\'s too), and not for a standing candidate that did not fire', async () => {
  const home = tmp();
  await afterAt(home, PREP);
  const f = PA.planFile(home, 'MNQ', FIRE);
  const plan = PA.readPlan(home, 'MNQ', FIRE);
  const matched = PA.matchScenario(plan, atCloseOf(home, FIRED).record.fired);
  assert.strictEqual(matched.status, 'matched');
  const lineOf = k => `Scenario ${k} is a standing setup`;
  // As made: the primary is the momentum fire (scenario 1); scenarios 2-4 are standing 15m reactions that fired too
  // (before C3 none of them was named, nor had its line).
  assert.deepStrictEqual(matched.matches.map(x => [x.k, x.kind]), [[1, 'momentum'], [2, 'standing'], [3, 'standing'], [4, 'standing']]);
  const asMade = atCloseOf(home, FIRED).confirm.suffix;
  assert.ok(!asMade.includes(lineOf(1)), 'none for the momentum scenario');
  for (const k of [2, 3, 4]) {
    assert.ok(asMade.includes(lineOf(k)), `${k}: ${asMade}`);
    // Each standing scenario said by code (its candidate's computed trigger, the fixed TAKE/PASS), never as the prepare wrote it.
    const sc = plan.scenarios.find(s => s.k === k);
    const cand = plan.candidates.find(c => c.id === sc.id);
    assert.match(cand.fires, /whatever its range, volume and close/, 'the plan keeps the computed trigger');
    // The three share one 15m candle, so one trigger: in full for scenario 2, the others pointing to it (review P2).
    assert.strictEqual(cand.fires, plan.candidates.find(c => c.id === plan.scenarios.find(s => s.k === 2).id).fires);
    assert.ok(asMade.includes(`scenario ${k}:\n${PA.standingScenarioLine(sc, cand, { firesAs: k === 2 ? null : 2 })}\n`), `scenario ${k}'s line by code`);
    assert.ok(!asMade.includes(sc.line), `scenario ${k}: not the prepare's line`);
  }
  assert.ok(asMade.includes(plan.scenarios[0].line), 'the momentum scenario as written');
  // A standing candidate that did not fire (with a scenario of its own): no line for it.
  const extra = { ...plan, candidates: plan.candidates.concat([{ id: 'P99', kind: 'standing', read: 'nothing fires this', side: 'short', tf: '15m' }]), scenarios: plan.scenarios.concat([{ k: 99, id: 'P99', candidate: 'P99 "nothing fires this"', line: 'SCENARIO 99: P99' }]) };
  fs.writeFileSync(f, JSON.stringify(extra));
  const a = atCloseOf(home, FIRED);
  assert.strictEqual(a.record.path, 'confirm');
  assert.ok(!a.confirm.suffix.includes(lineOf(99)) && !a.confirm.suffix.includes('SCENARIO 99'), a.confirm.suffix);
  assert.strictEqual(a.confirm.suffix, PA.confirmSuffix({ matched: PA.matchedScenarios(extra, matched), unplanned: matched.unplanned }));
  // The primary standing too: its line, first.
  fs.writeFileSync(f, JSON.stringify({ ...plan, candidates: plan.candidates.map(c => (c.id === matched.id ? { ...c, kind: 'standing' } : c)) }));
  assert.ok(atCloseOf(home, FIRED).confirm.suffix.includes(`${lineOf(1)}: the setup is the reaction the briefing lists`));
  // The record is as before: the primary's match only, no kind, no list.
  assert.ok(!('kind' in a.record) && !('matches' in a.record) && !('matched' in a.record), 'the record is as before');
  assert.deepStrictEqual(a.record.match, { k: 1, id: 'P1', read: 'momentum_continuation fired down', side: 'short' });
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
  // The confirm's own turn (spawn to its compose's result), its run, its reads; phase 2 and the executor from the entry's
  // timing: each apart, so close to order can be read by its parts.
  const turn = { turnMs: 6000, turnTo: 'compose', composes: 1, runMs: 9000, readsMs: 400 };
  const r = await afterAt(home, FIRED, { on, cycle: { ok: true, confirm: { outcome: 'done', ms: 7000, fellBack: false, late: ['chased-entry'], ...turn } }, timing: { latencyMs: { order: 21000 } }, context: { desk: { ms: 25000 } }, entry: { timing: { headMs: 12000, phase2Ms: 15000, executorMs: 5000, orderMs: 21000 } } });
  assert.deepStrictEqual(r.log.prepare.on, { ...on, confirm: { outcome: 'done', ms: 7000, fellBack: false, ...turn }, late: ['chased-entry'], closeToOrderMs: 21000, desk: 'ran', phase2Ms: 15000, executorMs: 5000 });
  // A confirm that failed before a compose: what it did is in the record (its tool calls, its output's end); no turn of
  // its own (the full head trader decided), no entry.
  const failedConfirm = await afterAt(tmp(), FIRED, { on, cycle: { ok: true, confirm: { outcome: 'error', ms: 3000, fellBack: true, late: [], tools: ['mcp__harness__bar_briefing'], tail: '...API Error: overloaded' } } });
  assert.deepStrictEqual(failedConfirm.log.prepare.on.confirm, { outcome: 'error', ms: 3000, fellBack: true, turnMs: null, turnTo: null, composes: null, runMs: null, readsMs: null, tools: ['mcp__harness__bar_briefing'], tail: '...API Error: overloaded' });
  assert.deepStrictEqual([failedConfirm.log.prepare.on.phase2Ms, failedConfirm.log.prepare.on.executorMs], [null, null]);
  // An entry of the full head trader's (a fallback path): its phase 2 and executor times too.
  const fallback = await afterAt(tmp(), FIRED, { on: { mode: 'on', path: 'outside' }, cycle: { ok: true }, entry: { timing: { phase2Ms: 22000, executorMs: 6000 } } });
  assert.deepStrictEqual([fallback.log.prepare.on.phase2Ms, fallback.log.prepare.on.executorMs, 'confirm' in fallback.log.prepare.on], [22000, 6000, false]);
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
