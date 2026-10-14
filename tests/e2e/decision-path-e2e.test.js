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
const { REQUIRED_FOR_ENTRY, REQUIRED_FOR_COMPOSED, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
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
  // Where it aims (the take-profit skill): the next swing per timeframe, and the last completed 1h (and 4h, when one has
  // completed) candle's high, mid and low, each a price on its side with points and R, closed by the fired bar's close.
  assert.ok([...m3.swingTargets.above, ...m3.swingTargets.below].length > 0, 'a swing target');
  assert.ok(!m3.rangeTargets['1h'].unavailable, 'a completed hour');
  for (const [tf, x] of Object.entries(m3.rangeTargets).filter(([, v]) => !v.unavailable)) {
    assert.ok(Date.parse(x.closedAt) <= Date.parse(FIRED_BAR) + 3 * 60000, `${tf}: completed`);
    for (const k of ['high', 'mid', 'low']) assert.ok(Number.isFinite(x[k].price) && ['above', 'below', 'at'].includes(x[k].side) && Number.isFinite(x[k].R), `${tf} ${k}`);
    assert.ok(x.low.price <= x.mid.price && x.mid.price <= x.high.price, tf);
  }
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
  assert.ok([...REQUIRED_FOR_COMPOSED, ...REQUIRED_AT_ENTRY].every(s => line.embeddedSkills.includes(s)), JSON.stringify(line));
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
// each, or a role's body points to it for skill_lookup (a sentence naming the skill and skill_lookup, in a role that holds
// the tool: top-down-entry, the market-structure analyst's setup step), so in either mode (FTH_ROLE_SKILLS full or index)
// some role can read it. The head trader loads by the skill tool.
const STEP_SKILLS = {
  bias: ['daily-bias', 'htf-to-ltf', 'bos-vs-choch', 'multi-timeframe-analysis'],
  location: ['levels-and-reactions', 'vwap-volume-profile'],
  setup: ['rejection', 'breakout', 'breakout-vs-fakeout', 'pullback-vs-reversal', 'cisd', 'fair-value-gaps', 'fib-retracement'],
  entry: ['candle-reading', 'momentum-and-volume'],
  stop: ['invalidation'],
  target: ['top-down-entry'],
  risk: ['position-sizing', 'confluence-counting'],
};
/** Whether a role's body points to skill `s` for skill_lookup: one sentence names both, and the role holds the tool. */
const pointsTo = (r, s) => r.tools.some(t => /(^|__)skill_lookup$/.test(t))
  && r.body.replace(/\s+/g, ' ').split(/(?<=\.)\s/).some(x => x.includes(`\`${s}\``) && x.includes('`skill_lookup`'));
test('decision path: each trader-process step has a skill a role embeds, indexes or points to for skill_lookup (both modes), and skill_lookup reads it', () => {
  const roles = loadRoles(D.ROOT);
  const { skillLookup } = require('../../scripts/lib/harness-tools/skills');
  const nowhere = [];
  for (const [step, skills] of Object.entries(STEP_SKILLS)) {
    for (const s of skills) {
      assert.match(skillLookup({ skill: s }, { root: D.ROOT, env: {} }).text, new RegExp(`^<skill name="${s}">`), `${step}: ${s}`);
      const by = roles.filter(r => r.skills.includes(s) || r.index.includes(s) || pointsTo(r, s));
      if (!by.length) nowhere.push(s);
    }
  }
  assert.deepStrictEqual(nowhere, []);
  // The pointer is read from the body's text: the market-structure analyst's setup step points to top-down-entry; a
  // body without the sentence, or a role without the tool, points to nothing.
  const msa = roles.find(r => r.name === 'market-structure-analyst');
  assert.ok(pointsTo(msa, 'top-down-entry') && !msa.skills.includes('top-down-entry') && !msa.index.includes('top-down-entry'));
  assert.ok(!pointsTo({ ...msa, body: msa.body.replace(/`top-down-entry`/g, 'the top-down skill') }, 'top-down-entry'));
  assert.ok(!pointsTo({ ...msa, tools: msa.tools.filter(t => !/skill_lookup$/.test(t)) }, 'top-down-entry'));
  assert.ok(!pointsTo(msa, 'position-sizing'));
});

test('decision path, veto: risk-manager phase 2 vetoes; no order is sent; recorded as vetoed on the setup, told apart from the model\'s own pass', async () => {
  const w = D.world();
  const r = await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { verdict: 'VETO' }));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.deepStrictEqual(D.gateLog(w), [], 'the executor was never called');
  const h = r.state.history.at(-1);
  assert.deepStrictEqual([h.action, h.setup, h.side, h.bar], ['vetoed', SETUP.strategy, SETUP.side, FIRED_BAR]);
  assert.match(h.result, /vetoed/);
  // The cycle log's fact check sees the veto report.
  const rec = JSON.parse(fs.readFileSync(D.cycleLines(w).at(-1).file, 'utf8'));
  assert.deepStrictEqual(rec.factCheck.reports.map(x => x.verdict), ['VETO']);
  // The next cycle's prompt shows it as vetoed, with what followed (its counterfactual's ground, as a pass's).
  const next = await D.pass(w, decisionAt(NEXT_BAR), D.passCycle(w, 'nothing new'));
  assert.match(next.ran[0].prompt, new RegExp(`MNQ 3m vetoed ${SETUP.strategy} ${SETUP.side}`));
  // Phase 2 approves and the model passes anyway: its own pass, skipped.
  const w2 = D.world();
  const own = D.entryCycle(w2).filter(x => !x.executor).map(x => (x.result ? { result: 'CYCLE RESULT: no-trade - approved, but I pass: the close came back inside the level' } : x));
  const r2 = await D.pass(w2, decisionAt(FIRED_BAR), own);
  assert.deepStrictEqual(D.placedAtBroker(w2), []);
  assert.deepStrictEqual([r2.state.history.at(-1).action, r2.state.history.at(-1).setup], ['skipped', SETUP.strategy]);
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
  assert.ok([...REQUIRED_FOR_COMPOSED, ...REQUIRED_AT_ENTRY].every(s => line.embeddedSkills.includes(s)), 'embedded, attested');
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
  // opencode's transcript holds the main session only: the executor's order is among the cycle log's orders from the
  // gateway's record of the cycle's window, with the arguments it judged.
  const sent = D.placedAtBroker(w)[0].args;
  assert.deepStrictEqual(line.orders, [{ contractId: plan.args.contractId, side: plan.args.side, size: plan.args.size, type: plan.args.type, rationale: String(D.gateLog(w).at(-1).rationale).slice(0, 200), gate: 'allowed', via: 'gate-log' }]);
  assert.match(line.orders[0].rationale, new RegExp(`^setup:${SETUP.strategy} ${SETUP.side}`));
  assert.deepStrictEqual([sent.side, sent.size, sent.type], [plan.args.side, plan.args.size, plan.args.type]);
  const placed = fs.readFileSync(w.journal, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.kind === 'order_placed');
  assert.strictEqual(placed.length, 1);
  assert.match(placed[0].text, new RegExp(`^setup:${SETUP.strategy} ${SETUP.side}`));
  // The cycle's timeline, on the replay clock: the bar's close, the start (the decision time), each role's call, the
  // decision (the entry order, as the gate logged it), the end, in that order; the setup decided and entered in time.
  const t = line.timing;
  const ms = x => Date.parse(x);
  const closeOf = bar => new Date(ms(bar) + D.STEP).toISOString();
  assert.deepStrictEqual([t.clock, t.barClose, t.nextBarClose, t.start, t.latencyMs.start], ['replay', closeOf(FIRED_BAR), closeOf(NEXT_BAR), decisionAt(FIRED_BAR), 2000]);
  assert.deepStrictEqual(t.roles.map(r => r.role), [...D.ANALYSTS, 'risk-manager', 'risk-manager', 'trade-executor']);
  assert.ok(t.roles.every(r => r.ms >= 0), JSON.stringify(t.roles));
  const reports = t.roles.filter(r => r.role !== 'trade-executor');
  const seq = [ms(t.barClose), ms(t.start), ...reports.flatMap(r => [ms(r.start), ms(r.end)]), ms(t.decision), ms(t.order), ms(t.end)];
  assert.deepStrictEqual(seq, [...seq].sort((a, b) => a - b), JSON.stringify(t));
  assert.strictEqual(t.decision, t.order, 'decided at the entry order');
  assert.ok(ms(t.order) >= ms(t.roles.at(-1).start), 'sent by the trade-executor');
  assert.deepStrictEqual([t.decisionFrom, t.orders, t.orderDecision, t.overran, t.setup, t.setupCaught, t.enteredInTime, t.setupMissed], ['transcript', 1, 'allowed', false, true, true, true, null]);
  assert.deepStrictEqual([t.latencyMs.decision, t.latencyMs.order], [ms(t.decision) - ms(t.barClose), ms(t.order) - ms(t.barClose)]);
  // The replay report carries it (store.js cycleSummary).
  assert.deepStrictEqual(require('../../scripts/lib/replay/store').cycleSummary(line).timing, t);
});

test('decision path, missed: a setup on the table, the model decides after the next bar closed; recorded as missed, overran', async () => {
  const w = D.world();
  await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, `${SETUP.strategy} ${SETUP.side} skipped: late`), { lateBy: 200000 });
  const t = D.cycleLines(w).at(-1).timing;
  assert.ok(Date.parse(t.decision) > Date.parse(t.nextBarClose) && Date.parse(t.end) > Date.parse(t.nextBarClose), JSON.stringify(t));
  assert.deepStrictEqual([t.clock, t.setup, t.overran, t.setupCaught, t.enteredInTime, t.setupMissed, t.order], ['replay', true, true, false, false, 'overran', null]);
  assert.ok(t.latencyMs.decision > 200000);
  // And in the report: one setup bar, missed for overrunning.
  const r = require('../../scripts/lib/cycle-timing').timingReport([{ timing: t }]);
  assert.deepStrictEqual([r.setup.cycles, r.setup.decidedInTime, r.setup.missed, r.setup.missedBy, r.all.overran], [1, 0, 1, { overran: 1 }, 1]);
});

// One refusal per missing piece: the entry cycle with that piece removed, the gate's one check that refuses it.
// The briefing's bar closed 10 minutes before the gate's clock (3m bars: over the 9-minute stale-data cap).
const oldClose = ctx => {
  const f = path.join(ctx.env.FTH_HOME, 'briefing', 'MNQ.json');
  const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  b.closedAt = new Date(Date.parse(ctx.env.FTH_REPLAY_NOW) - 10 * 60000).toISOString();
  fs.writeFileSync(f, JSON.stringify(b));
};
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
  ['index mode: the head prompt\'s attestation doesn\'t verify', { pre: ctx => { ctx.env.FTH_HEAD_PROMPT = JSON.stringify({ config: path.join(ctx.env.FTH_HOME, 'none.json'), sha256: '0'.repeat(64), skills: REQUIRED_FOR_ENTRY }); } }, ['skills-loaded', 'skills-at-entry'], new RegExp(`not loaded in this session: ${REQUIRED_FOR_ENTRY.filter(x => !D.STRATEGY_SKILLS.includes(x)).join(', ')}\\.`)],
  ...Object.entries(D.REQUIRED_LOOKUPS).flatMap(([role, skills]) => skills.map(s => [`${role} didn't look up ${s}`, { noLookup: { [role]: [s] } }, 'roles-ran', new RegExp(`${role} reported without looking up ${s}\\b`)])),
  ...Object.entries(D.REQUIRED_LOOKUPS).filter(([, s]) => s.length).map(([role, skills]) => [`${role}'s lookup of ${skills[0]} made outside its calls`, { outside: { [role]: [skills[0]] } }, 'roles-ran', new RegExp(`${role} reported without looking up ${skills[0]}\\b`)]),
  ...D.ANALYSTS.map(a => [`${a} never ran`, { dropRole: a }, 'roles-ran', new RegExp(`not returned yet: ${a}\\.`)]),
  ['risk-manager phase 2 never ran', { dropRole: 'phase2' }, 'roles-ran', /not returned yet: risk-manager phase 2/],
  ['the role calls carry no times', { untimed: true }, 'roles-ran', /market-structure-analyst reported without looking up/],
  ['no FACTS line', { facts: () => '' }, 'phase2-facts', /approved with 0 checkable facts/],
  ['one fact only', { facts: w => D.trueFacts(w)[0] }, 'phase2-facts', /approved with 1 checkable fact\b/],
  ['a false fact', { facts: w => `${D.trueFacts(w)[0]}; vwap ${D.flip[D.m3Of(w).vwap.side]}` }, 'phase2-facts', /a fact the bar briefing contradicts: "vwap /],
  ['a fact in no known form', { facts: w => `${D.trueFacts(w).join('; ')}; the tape looks strong` }, 'phase2-facts', /in no known form: "the tape looks strong"/],
  // The briefing another bar's: full mode, the facts can't be checked; index mode, it is no facts for the lookups
  // either, so every situational lookup is required (fails closed) and the roles' reports don't count.
  ['stale data: the briefing\'s bar closed over 3 of its bars ago', { act: oldClose }, 'briefing-age', /Stale data: the MNQ bar briefing's bar \(at [^)]*\) closed 10\.\d min ago, over the 9 min limit/],
  ['full mode: the briefing is another bar\'s', { act: staleBriefing, mode: 'full' }, 'phase2-facts', /briefing for this cycle's MNQ bar .* can't be read \(the MNQ briefing is for the bar at/],
  ['index mode: the briefing is another bar\'s', { act: staleBriefing }, 'roles-ran', /market-structure-analyst reported without looking up /],
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

// Live, the gate reads the wall clock: a delegated cycle (~10 minutes) reaches the executor after its bar briefing's
// m3.validUntil. The briefing of the cycle's bar (FTH_CYCLE_BARS) still decides the lookups and the cached key.
const expireBriefing = ctx => {
  const f = path.join(ctx.env.FTH_HOME, 'briefing', 'MNQ.json');
  const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  b.sections.m3.validUntil = new Date(Date.parse(ctx.env.FTH_REPLAY_NOW) - 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(b));
};

test('decision path, a long cycle: the executor\'s call comes after the briefing\'s validUntil; the briefing of the cycle\'s bar decides the lookups (made, or served from the cache): the order goes', async () => {
  const w = D.world();
  await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { act: expireBriefing }));
  const e = lastEntry(w);
  assert.deepStrictEqual([e.decision, e.checks], ['allowed', []], e.messages);
  assert.strictEqual(D.placedAtBroker(w).length, 1);
  // Served from the cache under the cycle's facts key, the bar's lookups counted though the briefing has expired.
  const c = D.world();
  const ms = 'market-structure-analyst';
  await D.pass(c, decisionAt(FIRED_BAR), D.passCycle(c, 'looking', { cacheable: true }));
  fs.unlinkSync(c.stateFile);
  const r = await D.pass(c, decisionAt(FIRED_BAR), D.entryCycle(c, { cacheable: true, dropRole: ms, lookups: { ...D.REQUIRED_LOOKUPS, [ms]: [] }, act: expireBriefing }));
  assert.ok(r.ran[0].context.cachedRoles.includes(ms), `served: ${r.ran[0].context.cachedRoles}`);
  const ce = lastEntry(c);
  assert.deepStrictEqual([ce.decision, ce.checks], ['allowed', []], ce.messages);
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
  assert.deepStrictEqual(decisions[0].violations.map(v => v.check), ['trigger-fired', 'skills-at-entry', 'roles-ran', 'phase2-facts', 'briefing-age', 'review-before-next-entry', 'position-open']);
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
];
for (const t of COMPOSED) test.todo(t);

// ---- trade_lifecycle, end to end: the model's own composed trade on the fired bar's real facts ----
// The reads are scenario 1's shape on the parity bar (price 27427.50): bias 4h up and the trend rule allows the long,
// location value above, setup the 15m candle rejected the prior VAH up, entry the 3m candle closed at its top, stop the last swing low 27404.75 (one tick beyond: 92
// ticks, $46.00 a micro), target the 1h swing 27512.00 (338 ticks, 3.67R). The head trader calls compose_check (the real
// harness tool); a tampered record (expired, another plan) is the latest one appended after it.
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const LC_READS = [
  { step: 'bias', skill: 'multi-timeframe-analysis', read: '4h up', why: 'the 4h trend is up' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'value above', why: 'above the prior value area' },
  { step: 'bias', skill: 'htf-to-ltf', read: 'trend long allowed', why: 'the trend rule takes the long' },
  { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up', why: 'the 15m dipped under the prior VAH and closed back above' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'the 3m bar closed at its high' },
  { step: 'stop', skill: 'invalidation', read: 'stop swing low 27404.75', why: 'under the last swing low it is wrong' },
  { step: 'target', skill: 'top-down-entry', read: 'target 1h swing 27512.00', why: 'the next 1h swing high' },
];
// The first read of a step swapped for another.
const lcSwap = (step, read) => LC_READS.map((x, i) => (i === LC_READS.findIndex(y => y.step === step) ? { ...x, read } : x));
const lcTamper = (ctx, tamper) => {
  const rec = TL.readRecords(ctx.env.FTH_HOME, 'MNQ').at(-1);
  TL.appendRecord(ctx.env.FTH_HOME, { ...rec, ...tamper(rec) });
};
const lcOrder = (o = {}) => ({ accountId: 7, contractId: 'MNQ', side: 'buy', type: 'limit', limitPrice: 27427.5, size: o.size || 1, stopLossBracket: { ticks: 92, type: 'stop' }, takeProfitBracket: { ticks: 338, type: 'limit' }, rationale: 'setup:trade_lifecycle long, 4h up, value above, stop 27404.50, target 27512.00', ...(o.order || {}) });
/** The head trader's composed cycle: the round, its lookups (trade-lifecycle and the composed ones), the record, the plan, phase 2, the executor. */
function composedCycle(w, o = {}) {
  return [
    ...D.roundSteps(w),
    ...D.entryLoads(w).map(s => ({ load: s })),
    ...['confluence-counting', 'invalidation', 'rejection'].filter(s => !(o.skip || []).includes(s)).map(s => ({ lookup: s })),
    { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: o.reads || LC_READS, size: o.size || 1 } },
    ...(o.tamper ? [{ act: ctx => lcTamper(ctx, o.tamper) }] : []),
    ...(o.before ? [{ act: o.before }] : []),
    { broker: 'journal_add', args: { kind: 'plan', contractId: 'MNQ', tags: ['setup:trade_lifecycle', 'MNQ'], text: 'composed long 4h up, value above, stop 27404.50, target 27512.00' } },
    { role: 'risk-manager', lookups: [], report: () => `Phase 2 on the trade_lifecycle long plan for MNQ.\nVERDICT: APPROVE - size ${o.size || 1}\nFACTS: ${D.trueFacts(w).join('; ')}` },
    { executor: [{ broker: 'place_order', args: lcOrder(o) }] },
    { result: o.result || `CYCLE RESULT: executed - trade_lifecycle long MNQ ${o.size || 1}` },
  ];
}

test('decision path, trade_lifecycle: the model composes the whole trade with compose_check; its limit entry goes with the record\'s brackets and size', async () => {
  const w = D.world();
  const r = await D.pass(w, decisionAt(FIRED_BAR), composedCycle(w));
  assert.deepStrictEqual(lastEntry(w), { decision: 'allowed', checks: [], messages: '' });
  const sent = D.placedAtBroker(w)[0].args;
  assert.deepStrictEqual([sent.type, sent.limitPrice, sent.size, sent.stopLossBracket.ticks, sent.takeProfitBracket.ticks], ['limit', 27427.5, 1, 92, 338]);
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.deepStrictEqual([rec.ok, rec.bar, rec.plan.stop.price, rec.plan.target.price, rec.plan.rr], [true, FIRED_BAR, 27404.5, 27512, 3.67], JSON.stringify(rec.problems));
  assert.match(r.ctx.results.compose_check, /^compose_check MNQ long/);
  // The cycle log judges the entry by the composed list (no strategy skill is missing from a composed entry).
  assert.deepStrictEqual(D.cycleLines(w).at(-1).missingSkills, []);
  assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION.executed);
});

const LC_REFUSALS = [
  ['a false read (the 1h trend is a range, not up)', { reads: lcSwap('bias', '1h up') }, /false by the briefing: "1h up"/],
  ['a true read for the other side (the 15m trend is down)', { reads: lcSwap('bias', '15m down') }, /against the long: "15m down"/],
  ['an unverifiable read (no 5m candle in a 3m runner\'s briefing)', { reads: lcSwap('entry', '5m close top') }, /unverifiable: "5m close top"/],
  ['a record that expired', { tamper: () => ({ expiresAt: '2026-04-28T04:12:00.000Z' }) }, /expired at 2026-04-28T04:12:00.000Z/],
  ['a record whose plan is not its reads\'', { tamper: rec => ({ plan: { ...rec.plan, stop: { ...rec.plan.stop, ticks: 60 } } }) }, /record's plan \(60-tick stop/],
  ['a record already used', { before: ctx => fs.appendFileSync(ctx.env.MOCK_JOURNAL, `${JSON.stringify({ ts: new Date(Date.parse(ctx.env.FTH_REPLAY_NOW) + 1000).toISOString(), kind: 'order_placed', contractId: 'MNQ', text: 'setup:trade_lifecycle long', data: { result: { success: true } } })}\n`) }, /already placed since this bar opened/],
  ['an order off the record (a market order)', { order: { type: 'market', limitPrice: undefined } }, /a market order/],
  ['an order off the record (another size)', { order: { size: 2 } }, /size 2 is not the size the record states \(1\)/],
];
for (const [name, o, message] of LC_REFUSALS) {
  test(`decision path, trade_lifecycle refused: ${name} -> [composed-reads]; nothing reaches the broker`, async () => {
    const w = D.world();
    await D.pass(w, decisionAt(FIRED_BAR), composedCycle(w, { ...o, result: BLOCKED }));
    const e = lastEntry(w);
    assert.strictEqual(e.decision, 'blocked');
    assert.ok(e.checks.includes('composed-reads'), e.messages);
    assert.match(e.messages, message);
    assert.deepStrictEqual(D.placedAtBroker(w), []);
  });
}

test('decision path, trade_lifecycle refused: a stated size over the dollar cap ([max-risk]), and a required lookup not made ([skills-loaded])', async () => {
  // 7 x 92 ticks x $0.50 = $322 over max_risk_usd $300: compose_check says NOT OK, and sent anyway, the plan check and
  // the cap both refuse it.
  let w = D.world();
  const r3 = await D.pass(w, decisionAt(FIRED_BAR), composedCycle(w, { size: 7, result: BLOCKED }));
  assert.match(r3.ctx.results.compose_check, /NOT OK/);
  let e = lastEntry(w);
  assert.ok(e.decision === 'blocked' && e.checks.includes('composed-reads') && e.checks.includes('max-risk'), JSON.stringify(e));
  w = D.world();
  await D.pass(w, decisionAt(FIRED_BAR), composedCycle(w, { skip: ['invalidation'], result: BLOCKED }));
  e = lastEntry(w);
  assert.deepStrictEqual([e.decision, e.checks], ['blocked', ['skills-loaded']], e.messages);
  assert.match(e.messages, /not loaded in this session: invalidation\./);
  assert.deepStrictEqual(D.placedAtBroker(w), []);
});

test('decision path, trade_lifecycle: with the position open, the stop moves and the exit go with no record, briefing or transcript', async () => {
  const w = D.world();
  await D.pass(w, decisionAt(FIRED_BAR), composedCycle(w));
  const stop = D.working(w).find(o => o.type === 4);
  assert.ok(stop, 'the stop bracket is working');
  const gone = ctx => {
    fs.unlinkSync(ctx.liveFile);
    fs.mkdirSync(ctx.liveFile);
    fs.unlinkSync(path.join(ctx.env.FTH_HOME, 'briefing', 'MNQ.json'));
    fs.rmSync(path.join(ctx.env.FTH_HOME, 'composed'), { recursive: true, force: true });
  };
  const r = await D.pass(w, decisionAt(NEXT_BAR), [
    { act: gone },
    { executor: [
      { broker: 'modify_order', args: { accountId: 7, orderId: stop.id, stopPrice: stop.stopPrice + 0.5 } },
      { broker: 'place_order', args: lcOrder() },
      { broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] the composed long out' } },
    ] },
    { result: 'CYCLE RESULT: managed - stop tightened, then out' },
  ]);
  assert.deepStrictEqual(r.ctx.calls.map(c => [c.tool, c.ok]), [['modify_order', true], ['place_order', false], ['place_order', true]]);
  assert.match(r.ctx.calls[1].text, /\[composed-reads\]/);
  assert.strictEqual(D.position(w), null, 'flat');
});

test('decision path, trade_lifecycle, the runner: the history and the cycle log keep the record; a resting limit is cancelled at its expiry, the next bar', async () => {
  const w = D.world();
  // A limit below the bar's close (better for a long): it rests unfilled. Its rationale states no prices (the brackets
  // are ticks from the fill; prices from the reference would disagree with the lower limit: [order-consistency]).
  const r = await D.pass(w, decisionAt(FIRED_BAR), composedCycle(w, { order: { limitPrice: 27420, rationale: 'setup:trade_lifecycle long, 4h up, value above, a limit under the close' } }));
  assert.deepStrictEqual(lastEntry(w), { decision: 'allowed', checks: [], messages: '' });
  const resting = D.working(w).filter(o => o.type === 1);
  assert.strictEqual(resting.length, 1, JSON.stringify(D.working(w)));
  assert.strictEqual(D.position(w), null);
  // The decision history: the setup is the composed trade, with its record (reads, checks, signature, stated size).
  const h = r.state.history.at(-1);
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.deepStrictEqual([h.action, h.setup, h.side, h.composed.id, h.composed.signature, h.composed.size, h.composeCalls], [D.RESULT_ACTION.executed, 'trade_lifecycle', 'long', rec.id, rec.signature, 1, 1]);
  assert.ok(h.composed.reads.every(x => x.check === true && x.agrees === true), JSON.stringify(h.composed.reads));
  // Stamped with its record's expiry (the next bar's close).
  assert.deepStrictEqual(Object.values(r.state.composedOrders), [{ expiresAt: rec.expiresAt, record: rec.id, root: 'MNQ' }]);
  // The cycle log: the cycle's compose_check call.
  const line = D.cycleLines(w).at(-1);
  assert.deepStrictEqual(line.composed, { calls: 1, ok: 1, signatures: [rec.signature] });
  assert.strictEqual(JSON.parse(fs.readFileSync(line.file, 'utf8')).composed[0].id, rec.id);
  // The next bar: the runner cancels it before the cycle (its record expired at that bar's open).
  const next = await D.pass(w, decisionAt(NEXT_BAR), D.passCycle(w, 'nothing new'));
  assert.deepStrictEqual(D.working(w).filter(o => o.type === 1), []);
  assert.ok(next.events.some(e => e.kind === 'composed_expired' && String(e.orderId) === String(resting[0].id)), JSON.stringify(next.events.map(e => e.kind)));
  assert.deepStrictEqual(next.state.composedOrders, {});
});
