'use strict';

/**
 * Decision paths end to end: every branch of a trade cycle, as the model decides it, through the production stack.
 * The live runner as the harness wires it (runner-wiring.js) runs a pass at a replayed time on real bars; its cycle
 * goes through the runner's own glue (scripts/lib/cycle-run.js: the cycle's environment, the live transcript, the
 * cycle log); a scripted model (tests/fixtures/scripted-model.js) stands in for opencode and plays the cycle: skill
 * loads, the roles' calls with their lookups through the real skill_lookup, the phase-2 verdict and FACTS, order_plan,
 * and the trade-executor's orders through the real order gateway to the mock exchange (a replay broker). What the
 * gate decides, what reached the broker, and what the runner recorded (the decision history, the cycle log, the
 * gate's log) are asserted for each branch.
 *
 * Scenario 0 (tests/fixtures/decision-path.js): the parity NQ bars, where the fixture strategy fx_break fires long
 * on the 04:09 UTC bar. The owner's scenario 1 has no committed bars yet; its composed entry is specified below as
 * test.todo (docs/COMPOSED-ENTRY.md), with scenario 2's facts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const exchange = require('../fixtures/mock-exchange');
const D = require('../fixtures/decision-path');
const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
const { requiredFor, needed } = require('../../scripts/lib/trading/skill-lookups');
const { trendRuleOf } = require('../../scripts/lib/trading/reasons');
const { stableHead } = require('../../scripts/lib/autotrader');
const { loadRoles } = require('../../scripts/lib/role-skills');

const { SETUP, FIRED_BAR, QUIET_BAR, NEXT_BAR, decisionAt } = D;
const BLOCKED = 'CYCLE RESULT: blocked - the order gate refused the entry';

/** The gate's last place_order decision: { decision, checks }. */
function lastEntry(w) {
  const e = D.gateLog(w).filter(x => /place_order/.test(String(x.tool || ''))).at(-1);
  return e ? { decision: e.decision, checks: (e.violations || []).map(v => v.check), messages: (e.violations || []).map(v => v.message).join('\n') } : null;
}

test('decision path: the fired bar\'s briefing holds the facts each step reads, by field; the lookups required are the code\'s', async () => {
  const w = D.world();
  await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, 'reading the briefing'));
  const m3 = D.m3Of(w);
  // The setup on the table: the candidate, its side, trend rule, stop, room and what agrees with it.
  const c = m3.candidates.find(x => x.name === SETUP.strategy);
  assert.deepStrictEqual([c.direction, c.trendRule, c.confluence.with], [SETUP.side, SETUP.trendRule, SETUP.with]);
  assert.ok(c.stopPoints > 0 && c.needR > 0 && c.inTheWay && Number.isFinite(c.inTheWay.R), 'stop, the R it needs and the first level in its way');
  // Bias and location, the facts phase 2 states: the trend rule for the side, the VWAP side, the prior value area, the window.
  assert.strictEqual(trendRuleOf(m3.trendRule)[SETUP.side], true);
  assert.ok(['above', 'below', 'at'].includes(m3.vwap.side));
  assert.ok(['inside', 'above', 'below'].includes(m3.location.priorValue));
  assert.deepStrictEqual([m3.window, m3.windowEntries], ['asia', 'allowed']);
  assert.strictEqual(m3.bar.t, FIRED_BAR);
  // The lookups each role must make on this bar, as the gate computes them (role-skills.js, skills-loaded.js SITUATIONAL).
  const req = requiredFor(D.ROOT);
  for (const role of Object.keys(D.REQUIRED_LOOKUPS)) {
    assert.deepStrictEqual(needed(role, req, m3).map(r => r.skill).sort(), [...D.REQUIRED_LOOKUPS[role]].sort(), role);
  }
});

test('decision path, pass: no candidate on the bar, the model passes; nothing reaches the broker; recorded as a no-trade', async () => {
  const w = D.world();
  const lookups = Object.fromEntries(Object.keys(D.REQUIRED_LOOKUPS).map(r => [r, []]));
  const r = await D.pass(w, decisionAt(QUIET_BAR), D.passCycle(w, 'nothing fired', { lookups }));
  assert.deepStrictEqual(D.m3Of(w).candidates, [], 'nothing fired on the bar');
  assert.deepStrictEqual(r.ran.map(x => [x.action, x.ok, x.result]), [['trade', true, 'CYCLE RESULT: no-trade - nothing fired']]);
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.deepStrictEqual(D.gateLog(w), []);
  const h = r.state.history.at(-1);
  assert.deepStrictEqual([h.action, h.bar, h.symbol, h.setup], ['no-trade', QUIET_BAR, 'MNQ', undefined]);
  const line = D.cycleLines(w).at(-1);
  assert.deepStrictEqual([line.result, line.orders, line.missingSkills], ['CYCLE RESULT: no-trade - nothing fired', [], []]);
  // Index mode: the head trader's per-cycle skills are embedded in its prompt, as the runner attested (none loaded by a tool).
  assert.deepStrictEqual(D.headLoads(w), []);
  assert.ok([...REQUIRED_FOR_ENTRY, ...REQUIRED_AT_ENTRY].every(s => line.embeddedSkills.includes(s)), JSON.stringify(line));
});

test('decision path, skip: a setup on the table, the model passes; recorded as skipped with its setup, side and 1R, shown with what followed', async () => {
  const w = D.world();
  const r = await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, `${SETUP.strategy} ${SETUP.side} skipped: no room, the first level in its way is under 1R`));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  const h = r.state.history.at(-1);
  const c = D.m3Of(w).candidates.find(x => x.name === SETUP.strategy);
  assert.deepStrictEqual([h.action, h.setup, h.side, h.bar], [D.RESULT_ACTION['no-trade'], SETUP.strategy, SETUP.side, FIRED_BAR]);
  assert.ok(Math.abs(h.stop - c.stopPoints) < 0.01, `1R ${h.stop} is the setup's stop ${c.stopPoints}`);
  // The next cycle's prompt carries the skipped decision with what happened since (its counterfactual's ground).
  const next = await D.pass(w, decisionAt(NEXT_BAR), D.passCycle(w, 'nothing new'));
  assert.match(next.ran[0].prompt, new RegExp(`MNQ 3m skipped ${SETUP.strategy} ${SETUP.side}`));
  // Both cycles' prompts open with the same stable head (the prompt cache's shared prefix); the time comes after it.
  for (const p of [r.ran[0].prompt, next.ran[0].prompt]) assert.ok(p.startsWith(`${stableHead(D.ROOT)} The cycle's time: `), p.slice(0, 200));
});

// Each trader-process step's skills (docs/COMPOSED-ENTRY.md section 1): a role embeds (role-skills) or indexes (role-index)
// each, so in either mode (FTH_ROLE_SKILLS full or index) some role can read it. The head trader loads by the skill tool.
const STEP_SKILLS = {
  bias: ['daily-bias', 'htf-to-ltf', 'bos-vs-choch', 'multi-timeframe-analysis'],
  location: ['levels-and-reactions', 'vwap-volume-profile'],
  setup: ['rejection', 'breakout', 'breakout-vs-fakeout', 'pullback-vs-reversal', 'cisd', 'fair-value-gaps', 'fib-retracement'],
  entry: ['candle-reading', 'momentum-and-volume'],
  stop: ['invalidation'],
  target: ['top-down-entry'],
  risk: ['position-sizing', 'confluence-counting'],
};
// Step skills in no role's lists: a role's body names them for skill_lookup, but its role-index doesn't list them, so
// index mode's prompt shows no index line for them (top-down-entry: agents/market-structure-analyst.md's body). A
// finding for a separate change; delete the entry when the index lists it.
const NOT_IN_A_ROLE_LIST = ['top-down-entry'];
test('decision path: each trader-process step has a skill a role embeds or indexes (both modes), and skill_lookup reads it', () => {
  const roles = loadRoles(D.ROOT);
  const { skillLookup } = require('../../scripts/lib/harness-tools/skills');
  const nowhere = [];
  for (const [step, skills] of Object.entries(STEP_SKILLS)) {
    for (const s of skills) {
      assert.match(skillLookup({ skill: s }, { root: D.ROOT, env: {} }).text, new RegExp(`^<skill name="${s}">`), `${step}: ${s}`);
      const by = roles.filter(r => r.skills.includes(s) || r.index.includes(s));
      if (!by.length) nowhere.push(s);
    }
  }
  assert.deepStrictEqual(nowhere, NOT_IN_A_ROLE_LIST);
});

test('decision path, veto: risk-manager phase 2 vetoes; no order is sent; recorded as a no-trade on the setup with the veto in its result', async () => {
  const w = D.world();
  const r = await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { verdict: 'VETO' }));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.deepStrictEqual(D.gateLog(w), [], 'the executor was never called');
  const h = r.state.history.at(-1);
  assert.deepStrictEqual([h.action, h.setup, h.side], [D.RESULT_ACTION['no-trade'], SETUP.strategy, SETUP.side]);
  assert.match(h.result, /vetoed/);
  // The cycle log's fact check sees the veto report.
  const rec = JSON.parse(fs.readFileSync(D.cycleLines(w).at(-1).file, 'utf8'));
  assert.deepStrictEqual(rec.factCheck.reports.map(x => x.verdict), ['VETO']);
});

test('decision path, entry: every skill, lookup, role and fact in place: the order goes, fills with its stop, and is recorded', async () => {
  const w = D.world();
  const r = await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w));
  assert.deepStrictEqual(lastEntry(w), { decision: 'allowed', checks: [], messages: '' });
  const plan = D.planOf(r.ctx.results.order_plan);
  // At the broker: a long of 1 at the bar's close, its stop bracket order_plan's ticks below it.
  const pos = D.position(w);
  assert.deepStrictEqual([pos.type, pos.size, pos.averagePrice], [1, 1, D.m3Of(w).price]);
  const stopLeg = D.working(w).find(o => o.type === 4);
  assert.strictEqual(stopLeg.stopPrice, pos.averagePrice - plan.ticks * 0.25);
  assert.strictEqual(stopLeg.stopPrice, plan.stopPrice, 'filled at the signal close: the stop where order_plan put it');
  assert.ok(D.placedAtBroker(w).every(c => c.args.contractId === D.MNQ_ID), 'the broker saw its own contract id');
  // The decision history: entered, the order's setup, side, 1R from its bracket, its order id.
  const h = r.state.history.at(-1);
  assert.deepStrictEqual([h.action, h.setup, h.side, h.stop, h.entrySize, h.flatAt], [D.RESULT_ACTION.executed, SETUP.strategy, SETUP.side, plan.ticks * 0.25, 1, true]);
  assert.strictEqual(h.orderId, D.placedAtBroker(w).length && exchange.read(w.state).orders[0].id);
  // The cycle log: every required skill loaded; the phase-2 facts all true; the lookups made, by role.
  const line = D.cycleLines(w).at(-1);
  assert.deepStrictEqual([line.result, line.missingSkills], [`CYCLE RESULT: executed - ${SETUP.strategy} ${SETUP.side} MNQ 1`, []]);
  assert.ok([...REQUIRED_FOR_ENTRY, ...REQUIRED_AT_ENTRY].every(s => line.embeddedSkills.includes(s)), 'embedded, attested');
  assert.deepStrictEqual(line.factCheck, { reports: 1, claims: 3, true: 3, false: 0, unchecked: 0 });
  const byRole = Object.fromEntries(Object.entries(D.REQUIRED_LOOKUPS).filter(([, s]) => s.length).map(([role, s]) => [role, s.length * (role === 'risk-manager' ? 2 : 1)]));
  assert.deepStrictEqual([line.skillLookups.mode, line.skillLookups.byRole], ['index', byRole]);
  // Judged as the gate judged them: at the replayed time, on its bar briefing (the gate saw every lookup met).
  const required = Object.entries(D.REQUIRED_LOOKUPS).filter(([, s]) => s.length).reduce((n, [role]) => n + (role === 'risk-manager' ? 2 : 1), 0); // role calls (phase 1 and 2: two)
  assert.deepStrictEqual([line.skillLookups.requiredCalls, line.skillLookups.met], [required, required], JSON.stringify(line.skillLookups));
  // Filed under the replayed time's trading day, stamped with it; `at` stays the wall clock (the gate log's).
  const at = decisionAt(FIRED_BAR);
  assert.strictEqual(line.cycleAt, at);
  assert.strictEqual(path.basename(path.dirname(line.file)), require('../../scripts/lib/trading/clock').tradingDayKey(new Date(at)));
  assert.ok(Math.abs(Date.parse(line.at) - Date.now()) < 10 * 60000, 'at: the wall clock');
  // What the record can't show today: opencode's transcript holds the main session only, so the executor's order is
  // not among the cycle log's orders (the gate's log and the journal have it).
  assert.deepStrictEqual(line.orders, []);
  const placed = fs.readFileSync(w.journal, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.kind === 'order_placed');
  assert.strictEqual(placed.length, 1);
  assert.match(placed[0].text, new RegExp(`^setup:${SETUP.strategy} ${SETUP.side}`));
});

// One refusal per missing piece: the entry cycle with that piece removed, the gate's one check that refuses it.
const staleBriefing = ctx => {
  const f = path.join(ctx.env.FTH_HOME, 'briefing', 'MNQ.json');
  const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  b.asOf = QUIET_BAR;
  fs.writeFileSync(f, JSON.stringify(b));
};
const REFUSALS = [
  // Full mode (FTH_ROLE_SKILLS=full): the head trader loads its skills with the skill tool, so each must show.
  ...REQUIRED_FOR_ENTRY.map(s => [`full mode: ${s} not loaded`, { skip: [s], mode: 'full' }, ['skills-loaded'], new RegExp(`not loaded in this session: ${s}\\b`)]),
  ...REQUIRED_AT_ENTRY.map(s => [`full mode: ${s} not read before the entry`, { skip: [s], mode: 'full' }, ['skills-at-entry'], new RegExp(`not read in this session: ${s}\\b`)]),
  // Index mode: an attestation the gate can't verify counts no embedded skill, so the transcript (no loads) decides.
  ['index mode: the head prompt\'s attestation doesn\'t verify', { pre: ctx => { ctx.env.FTH_HEAD_PROMPT = JSON.stringify({ config: path.join(ctx.env.FTH_HOME, 'none.json'), sha256: '0'.repeat(64), skills: REQUIRED_FOR_ENTRY }); } }, ['skills-loaded', 'skills-at-entry'], new RegExp(`not loaded in this session: ${REQUIRED_FOR_ENTRY.join(', ')}\\.`)],
  ...Object.entries(D.REQUIRED_LOOKUPS).flatMap(([role, skills]) => skills.map(s => [`${role} didn't look up ${s}`, { noLookup: { [role]: [s] } }, 'roles-ran', new RegExp(`${role} reported without looking up ${s}\\b`)])),
  ...Object.entries(D.REQUIRED_LOOKUPS).filter(([, s]) => s.length).map(([role, skills]) => [`${role}'s lookup of ${skills[0]} made outside its calls`, { outside: { [role]: [skills[0]] } }, 'roles-ran', new RegExp(`${role} reported without looking up ${skills[0]}\\b`)]),
  ...D.ANALYSTS.map(a => [`${a} never ran`, { dropRole: a }, 'roles-ran', new RegExp(`not returned yet: ${a}\\.`)]),
  ['risk-manager phase 2 never ran', { dropRole: 'phase2' }, 'roles-ran', /not returned yet: risk-manager phase 2/],
  ['the role calls carry no times', { untimed: true }, 'roles-ran', /market-structure-analyst reported without looking up/],
  ['no FACTS line', { facts: () => '' }, 'phase2-facts', /approved with 0 checkable facts/],
  ['one fact only', { facts: w => D.trueFacts(w)[0] }, 'phase2-facts', /approved with 1 checkable fact\b/],
  ['a false fact', { facts: w => `${D.trueFacts(w)[0]}; vwap ${D.flip[D.m3Of(w).vwap.side]}` }, 'phase2-facts', /a fact the bar briefing contradicts: "vwap /],
  ['a fact in no known form', { facts: w => `${D.trueFacts(w).join('; ')}; the tape looks strong` }, 'phase2-facts', /in no known form: "the tape looks strong"/],
  ['the briefing is another bar\'s', { act: staleBriefing }, 'phase2-facts', /briefing for this cycle's MNQ bar .* can't be read \(the MNQ briefing is for the bar at/],
  ['no journal plan', { plan: false }, 'plan-required', /No journal plan for MNQ/],
  ['no setup tag', { rationale: p => p.args.rationale.replace(/^setup:\S+ /, '') }, 'setup-tag', /must start with the strategy as setup:<name>/],
  ['a setup tag that names no strategy (a composed entry today)', { rationale: p => p.args.rationale.replace(/^setup:\S+/, 'setup:composed') }, 'strategy', /setup:composed is not a known strategy/],
];
for (const [name, { mode, ...o }, check, message] of REFUSALS) {
  const checks = [].concat(check);
  test(`decision path, refused: ${name} -> [${checks.join('], [')}]; nothing reaches the broker; recorded as blocked`, async () => {
    const w = D.world({ mode });
    const r = await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { result: BLOCKED, ...o }));
    const e = lastEntry(w);
    assert.deepStrictEqual([e.decision, e.checks], ['blocked', checks], e.messages);
    assert.match(e.messages, message);
    assert.deepStrictEqual(D.placedAtBroker(w), []);
    assert.strictEqual(D.position(w), null);
    assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION.blocked);
    // The executor's refusal is in its report, which the cycle log keeps.
    assert.match(JSON.parse(fs.readFileSync(D.cycleLines(w).at(-1).file, 'utf8')).transcript, new RegExp(`place_order: refused[^"]*\\[${checks[0]}\\]`));
  });
}

test('decision path, refused: the strategy named did not fire on the bar (no order_plan, the model\'s own order) -> [trigger-fired]', async () => {
  const w = D.world();
  const none = Object.fromEntries(Object.keys(D.REQUIRED_LOOKUPS).map(r => [r, []]));
  const r = await D.pass(w, decisionAt(QUIET_BAR), D.entryCycle(w, { manual: true, lookups: none, facts: wd => D.trueFacts(wd).slice(1).join('; '), result: BLOCKED }));
  const e = lastEntry(w);
  assert.deepStrictEqual([e.decision, e.checks], ['blocked', ['trigger-fired']], e.messages);
  assert.match(e.messages, new RegExp(`setup:${SETUP.strategy} ${SETUP.side} did not fire on the last closed MNQ bar`));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION.blocked);
});

test('decision path, position open: a stop move, a partial close, the stop cut to size and exits go with no skill, lookup, role, briefing or readable transcript; a loosened stop and a new entry don\'t', async () => {
  const w = D.world();
  // The entry, size 3 (the model's size within the gate's limits).
  await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { result: `CYCLE RESULT: executed - ${SETUP.strategy} ${SETUP.side} MNQ 3`, size: 3 }));
  assert.strictEqual(D.position(w).size, 3);
  const stop = D.working(w).find(o => o.type === 4);
  const gone = ctx => {
    // Nothing the entry checks can read: the transcript and the briefing removed.
    fs.unlinkSync(ctx.liveFile);
    fs.mkdirSync(ctx.liveFile); // a path that reads as no file, and takes no more writes
    fs.unlinkSync(path.join(ctx.env.FTH_HOME, 'briefing', 'MNQ.json'));
  };
  const r = await D.pass(w, decisionAt(NEXT_BAR), [
    { act: gone },
    { executor: [
      { broker: 'modify_order', args: { accountId: 7, orderId: stop.id, stopPrice: stop.stopPrice + 0.5 } },
      { broker: 'modify_order', args: { accountId: 7, orderId: stop.id, stopPrice: stop.stopPrice - 10 } },
      { broker: 'place_order', args: D.manualArgs(`setup:${SETUP.strategy} ${SETUP.side} add`) },
      { broker: 'partial_close_position', args: { accountId: 7, contractId: 'MNQ', size: 1 } },
      { broker: 'modify_order', args: { accountId: 7, orderId: stop.id, size: 2, reason: '[protect] the stop cut to the 2 left' } },
      { broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] one more off' } },
      { broker: 'close_position', args: { accountId: 7, contractId: 'MNQ' } },
    ] },
    { result: 'CYCLE RESULT: managed - stop tightened, scaled out, then out' },
  ]);
  const said = r.ctx.calls.map(c => [c.tool, c.ok]);
  assert.deepStrictEqual(said, [['modify_order', true], ['modify_order', false], ['place_order', false], ['partial_close_position', true], ['modify_order', true], ['place_order', true], ['close_position', true]], JSON.stringify(r.ctx.calls.map(c => c.text.slice(0, 300))));
  assert.match(r.ctx.calls[1].text, /\[modify-protection\]/);
  assert.strictEqual(D.position(w), null, 'flat');
  // The new entry: refused by the entry checks the exits never meet (the transcript can't be read, a position is open).
  const decisions = D.gateLog(w).filter(g => g.tool === 'place_order').slice(1);
  assert.deepStrictEqual(decisions.map(g => g.decision), ['blocked', 'allowed']);
  assert.deepStrictEqual(decisions[0].violations.map(v => v.check), ['trigger-fired', 'skills-at-entry', 'roles-ran', 'phase2-facts', 'review-before-next-entry', 'position-open']);
  // The gate's log: the only risk-reducing call held is the loosened stop, by its own rule.
  const entry = g => g.tool === 'place_order' && !/^\s*\[(exit|protect)\]/i.test(String(g.rationale || ''));
  const held = D.gateLog(w).filter(g => g.decision === 'blocked' && !entry(g));
  assert.deepStrictEqual(held.flatMap(g => g.violations.map(v => v.check)), ['modify-protection']);
  assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION.managed);
});

test('decision path, handoffs: head trader -> analysts -> risk-manager phase 1 -> phase 2 -> trade-executor, as the gate sees the order', async () => {
  // The verdict given before the analysts returned: that call is phase 1, the next risk-manager call is phase 2, and it
  // approves nothing.
  let w = D.world();
  const steps = D.entryCycle(w);
  const p2 = steps.findIndex(s => s.role === 'risk-manager' && /VERDICT/.test(String(s.report)));
  const early = [...steps.slice(0, 1), steps[p2], ...steps.slice(1, p2), ...steps.slice(p2 + 1)];
  await D.pass(w, decisionAt(FIRED_BAR), early);
  let e = lastEntry(w);
  assert.deepStrictEqual([e.decision, e.checks], ['blocked', ['roles-ran']]);
  assert.match(e.messages, /not returned yet: risk-manager phase 2 approving the plan \(its latest verdict is not "VERDICT: APPROVE"\)/);

  // A refused trade-executor call ends the round: the next entry in the same cycle needs every role again.
  w = D.world();
  const base = D.entryCycle(w, { plan: false, result: BLOCKED });
  const exec = base.find(s => s.executor);
  const again = [...base.filter(s => !s.result), { broker: 'journal_add', args: { kind: 'plan', contractId: 'MNQ', tags: [`setup:${SETUP.strategy}`], text: 'the plan, now' } }, exec, { result: BLOCKED }];
  await D.pass(w, decisionAt(FIRED_BAR), again);
  const entries = D.gateLog(w).filter(x => /place_order/.test(String(x.tool)));
  assert.deepStrictEqual(entries.map(x => x.violations.map(v => v.check)), [['plan-required'], ['roles-ran']]);
  assert.match(entries[1].violations[0].message, /not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager phase 1/);
  assert.deepStrictEqual(D.placedAtBroker(w), []);
});

test('decision path, report cache: a role whose bar requires a lookup is run, not served from the cache', async () => {
  const w = D.world();
  const none = Object.fromEntries(Object.keys(D.REQUIRED_LOOKUPS).map(r => [r, []]));
  await D.pass(w, decisionAt(QUIET_BAR), D.passCycle(w, 'nothing fired', { lookups: none }));
  const r = await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, 'looking'));
  const served = r.ran[0].context.cachedRoles || [];
  assert.deepStrictEqual(served, D.CACHE_SERVED);
  for (const [role, skills] of Object.entries(D.REQUIRED_LOOKUPS)) {
    if (skills.length) assert.ok(!served.includes(role), `${role} needs a lookup on this bar: not served (${served})`);
  }
});

test('decision path, report cache: a cached analyst whose own call made the lookups is served again under the same facts key, and the gate counts its lookups for the entry', async () => {
  const w = D.world();
  const ms = 'market-structure-analyst';
  // The fired bar, the analysts making the lookups it requires, their reports cacheable; then the same bar again (a
  // rerun of its decision: the runner's state cleared, its report cache kept).
  await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, 'looking', { cacheable: true }));
  const cache = JSON.parse(fs.readFileSync(path.join(w.home, 'report-cache.json'), 'utf8'));
  const key = D.m3Version(w);
  assert.deepStrictEqual([cache.analysts[ms].lookups, cache.analysts[ms].lookupsKey], [[...D.REQUIRED_LOOKUPS[ms]].sort(), key]);
  fs.unlinkSync(w.stateFile);
  const r = await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { cacheable: true, dropRole: ms, lookups: { ...D.REQUIRED_LOOKUPS, [ms]: [] } }));
  const ctx = r.ran[0].context;
  assert.ok(ctx.cachedRoles.includes(ms), `served: ${ctx.cachedRoles}`);
  assert.deepStrictEqual(ctx.cachedLookups[ms], { skills: [...D.REQUIRED_LOOKUPS[ms]].sort(), key });
  // The entry goes: the gate counts the cached report's lookups (FTH_CYCLE_CACHED_LOOKUPS) under the same key.
  const e = lastEntry(w);
  assert.deepStrictEqual([e.decision, e.checks], ['allowed', []], e.messages);
  assert.strictEqual(D.placedAtBroker(w).length, 1);
});

test('decision path, report cache: lookups made under another facts key (a quiet bar) are not credited to the fired bar\'s new candidate: the analyst runs again', async () => {
  const w = D.world();
  const ms = 'market-structure-analyst';
  // The quiet bar: the structure analyst looks up the breakout skills anyway; its report is cached with them, under the quiet bar's key.
  const none = Object.fromEntries(Object.keys(D.REQUIRED_LOOKUPS).map(role => [role, []]));
  await D.pass(w, decisionAt(QUIET_BAR), D.passCycle(w, 'nothing fired', { cacheable: true, lookups: { ...none, [ms]: D.REQUIRED_LOOKUPS[ms] } }));
  const cache = JSON.parse(fs.readFileSync(path.join(w.home, 'report-cache.json'), 'utf8'));
  assert.deepStrictEqual(cache.analysts[ms].lookups, [...D.REQUIRED_LOOKUPS[ms]].sort());
  const quietKey = cache.analysts[ms].lookupsKey;
  // The fired bar: a new candidate, a new key; the analyst is not served, those that need no lookup are.
  const r = await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, 'looking', { cacheable: true }));
  assert.notStrictEqual(D.m3Version(w), quietKey);
  const served = r.ran[0].context.cachedRoles || [];
  assert.ok(!served.includes(ms), `${ms} served on a new candidate: ${served}`);
  assert.deepStrictEqual(r.ran[0].context.cachedLookups || {}, {});
  assert.ok(served.includes('trend-momentum-analyst') && served.includes('volume-liquidity-analyst'), `served: ${served}`);
});

test('decision path, result: a cycle that reports blocked with no order call or executor launch is scored as no-trade (skipped, the setup on the table); its own line kept', async () => {
  const w = D.world();
  const r = await D.pass(w, decisionAt(FIRED_BAR), [...D.roundSteps(w), { result: 'CYCLE RESULT: blocked - the trend rule' }]);
  assert.deepStrictEqual([r.ran[0].result, r.ran[0].reportedResult], ['CYCLE RESULT: no-trade - the trend rule', 'CYCLE RESULT: blocked - the trend rule']);
  assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION['no-trade']);
  const line = D.cycleLines(w).at(-1);
  assert.deepStrictEqual([line.result, line.reportedResult], ['CYCLE RESULT: no-trade - the trend rule', 'CYCLE RESULT: blocked - the trend rule']);
  assert.ok(r.logs.some(l => /the agent wrote "CYCLE RESULT: blocked - the trend rule"/.test(l)), r.logs.join('\n'));
});

// The composed (model-originated) entry: designed (docs/COMPOSED-ENTRY.md), not built. These define "done".
const COMPOSED = [
  // The reads: each trader-process step stated by the model and checked by code.
  'composed, scenario 1: the model states its reads through compose_check, one per trader-process step (bias: 1h bos up, above prior RTH range; location: at prior VAH; setup: 15m rejected prior VAH up; entry: 3m close top, 3m momentum up; stop; target), each checked by code against the cycle bar\'s briefing',
  'composed: each read checked: a false read, an unchecked read (no field, no briefing), a read in no known form, and a step with no read each refuse, naming the read',
  'composed: the reads\' side must agree with the order (a long\'s bias up, setup up, stop below, target above): a read for the other side refuses',
  // The plan: stop, target, the minimum stop and the limit entry.
  'composed: the stop is the invalidation level the reads named (a candle low, a confirmed swing, a key level) on the losing side, placed the D3 buffer beyond it; the bracket ticks equal the record\'s. Scenario 1 (entry reference 21540.25, invalidation 21512.75): with D3\'s proposed 1-tick buffer the stop is 21512.50, 111 ticks, $55.50 per MNQ, 2.08R to 21598.00; the expected ticks follow D3, never hard-coded',
  'composed: the target is a real level on the winning side (a swing target or a key level): scenario 1 21598.00, 231 ticks from the reference; R:R under risk.min_rr refuses',
  'composed: the minimum stop (D13): a stop closer than the floor refuses the combination; it is never widened to the floor',
  'composed: the entry is a limit order at the record\'s entry reference or better: composed-reads refuses a market order, or a limit worse than the reference',
  'composed: the runner cancels a working composed limit at the record\'s expiresAt (the next base-bar close); an unfilled entry never outlives its record',
  // The gate.
  'composed, scenario 1: with every read true, setup:composed long goes in paper and replay (strategies/composed, status paper) and is refused live until promoted',
  'composed: the gate\'s composed-reads check re-runs the reads checker on the record\'s reads against the cycle bar\'s briefing: a record marked ok whose reads are false now refuses (the ok flag is never trusted)',
  'composed: composed-reads refuses no record, an expired record (past expiresAt), a used record, a record for the other side, or a size over its maxSize; it runs keyed on the tag even when strategies/composed is missing or invalid; an exit is never held by it',
  'composed: an exploratory record (a thin cell, D18) is an entry only in replay practice: any other run refuses it; its size is the minimum',
  'composed: phase-2 room facts are checked against the record\'s first level in the way, not a scan candidate',
  'composed: every old strategy deleted (D14): an entry naming one refuses ([strategy]), while the exits, stops and closes of a position it opened keep working',
  'composed, inside a prop attempt: compose_check asks the prop verdict (the budget, the rulebook multiplier, one entry per verdict) when the policy lists composed',
  // The records the learning loop reads.
  'composed: the record (reads, each check, field and value, plan, signature, exploratory flag) is appended to <FTH_HOME>/composed/<ROOT>.jsonl and named in the journal plan',
  'composed: the decision history records setup composed, the signature, the record\'s stop and target; a pass with an ok record is skipped, its counterfactual the same limit at the reference until expiresAt with the record\'s stop and target',
  'composed: the cycle log records every compose_check call (its record or refusal) beside factCheck; labels and the scorecard read the record, not "no setup"; a limit entry and the record\'s target are no clone reasons',
  'composed: the learning log: each decision\'s signature, context (regime, bias, session) and outcome in R is recorded append-only; experience_lookup reads it by signature with sample sizes, and its calls are recorded like skill_lookup\'s (required before an entry once D15 says so)',
  'composed, scenario 2 facts: the 4h candle that swept the prior 4h low and closed back, the 5m structure shift, the open 5m FVG and its retest, and the 4h high as a target are briefing fields',
  // Record gaps these tests exposed (follow-ups).
  'cycle log: the trade-executor\'s orders are visible in an opencode cycle\'s record (today only the main session\'s calls are: orders [])',
  'decision history: a risk-manager veto is told apart from the model\'s own pass (today both are skipped)',
];
for (const t of COMPOSED) test.todo(t);
