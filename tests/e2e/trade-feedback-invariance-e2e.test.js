'use strict';

/**
 * The trade feedback is information, never a decision (trading/trade-feedback.js): the same entry cycle through the
 * production stack (the decision-path world: the live runner, the cycle glue, the real order gateway and the mock
 * exchange) with the journal's earlier reviewed trades carrying their feedback (trip tags: the lines and the per-read
 * record in the head trader's prompt) and without it (the plain lines) decides and acts the same: the gate's decisions
 * and checks, order_plan's reply (its size), the orders the broker saw and their brackets, the position, the runner's
 * decision history, the cycle's result, entry, facts check and composed records. Only the prompt differs. And no
 * module that decides reaches the feedback module except through the review it writes and the prompt.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const exchange = require('../fixtures/mock-exchange');
const D = require('../fixtures/decision-path');
const F = require('../../scripts/lib/trading/trade-feedback');

const { SETUP, FIRED_BAR, decisionAt } = D;
const RESULT = `CYCLE RESULT: executed - ${SETUP.strategy} ${SETUP.side} MNQ 1`;

const VOLATILE = new Set(['ts', 'at', 'time', 'start', 'end', 'durationMs', 'ms', 'writtenAt', 'builtAt', 'savedAt', 'file', 'transcript', 'liveFile', 'promptHash', 'promptChars', 'creationTimestamp', 'updateTimestamp', 'timing', 'usage', 'stateRead', 'cycle', 'cycleId', 'id', 'orderId', 'session', 'sessionID', 'pid']);
function norm(x, home) {
  const plain = s => s.split(home).join('<home>').replace(/fth-[0-9a-f]{16}/g, 'fth-<tag>');
  return JSON.parse(JSON.stringify(x, (k, v) => (VOLATILE.has(k) ? undefined : typeof v === 'string' ? plain(v) : v)));
}
function decided(w, r) {
  const ex = exchange.read(w.state);
  const line = D.cycleLines(w).at(-1);
  return norm({
    gate: D.gateLog(w).map(e => ({ tool: e.tool, decision: e.decision, checks: (e.violations || []).map(v => v.check), source: e.source })),
    orderPlan: r.ctx.results.order_plan,
    broker: ex.calls.map(c => ({ tool: c.tool, args: c.args })),
    positions: ex.positions.map(p => ({ contractId: p.contractId, type: p.type, size: p.size, averagePrice: p.averagePrice })),
    orders: ex.orders.map(o => ({ contractId: o.contractId, type: o.type, side: o.side, size: o.size, status: o.status, stopPrice: o.stopPrice, limitPrice: o.limitPrice })),
    history: (r.state.history || []).map(h => ({ action: h.action, setup: h.setup, side: h.side, stop: h.stop, entrySize: h.entrySize, flatAt: h.flatAt })),
    cycle: { result: line.result, entry: line.entry, orders: line.orders, factCheck: line.factCheck, composed: line.composed, missingSkills: line.missingSkills },
  }, w.home);
}

/** Six of the prior day's reviewed trades, with their trip tags (the feedback) or without (the plain lines). */
function seed(w, withFeedback) {
  const lines = [];
  for (let i = 0; i < 6; i += 1) {
    const open = Date.parse('2026-04-27T14:00:00Z') + i * 1800000;
    const R = i % 2 ? 1.4 : -1;
    const trip = withFeedback ? F.tripTags({ side: 'long', size: 1, fill: 27400, exit: 27400 + R * 4.5, openedAt: new Date(open).toISOString(), closedAt: new Date(open + 600000).toISOString(), risk: 4.5, exitReason: R > 0 ? 'target' : 'stop' }) : [];
    lines.push(JSON.stringify({ ts: new Date(open + 660000).toISOString(), kind: 'review', contractId: 'MNQ', orderId: 900 + i, text: `runner: ${SETUP.strategy} long 1 MNQ`, tags: ['by:runner', `result:${R > 0 ? 'win' : 'loss'}`, `setup:${SETUP.strategy}`, 'MNQ', `r:${R}`, ...trip] }));
  }
  fs.appendFileSync(w.journal, `${lines.join('\n')}\n`);
}

test('trade feedback invariance: with the lines and the record or without, the entry cycle decides and acts the same; only the prompt differs', { timeout: 600000 }, async () => {
  const got = {};
  for (const name of ['plain', 'feedback']) {
    const w = D.world();
    seed(w, name === 'feedback');
    const r = await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { result: () => `PLAN:\n1 HTF: ...\n${RESULT}` }));
    got[name] = { decided: decided(w, r), prompt: r.ran.map(x => x.prompt).join('\n') };
  }
  assert.ok(got.plain.decided.broker.some(c => c.tool === 'place_order'), 'the entry went');
  assert.deepStrictEqual(got.feedback.decided, got.plain.decided, 'decided and acted as without the feedback');
  // The prompt is what differs: the framing, the feedback lines (unknown MAE/MFE said so) and the record past the floor.
  assert.match(got.feedback.prompt, /a record, not a rule; weigh each figure by its n/);
  assert.match(got.feedback.prompt, /long; reads: unknown; 1 MNQ; exit stop; loss R -1; MAE /);
  // No reads at entry here (no compose record stamped): no per-read record, whatever the count (its unit test has one).
  assert.doesNotMatch(got.feedback.prompt, /Record per read/);
  assert.doesNotMatch(got.plain.prompt, /a record, not a rule|Record per read/);
  assert.match(got.plain.prompt, /Your last 6 reviewed trade\(s\)/);
});

/** Every scripts/ module a file reaches through its require calls (relative paths, lazy ones too), itself included. */
function reach(file, stops, seen = new Set()) {
  if (seen.has(file) || stops.includes(file)) return seen;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    let target = path.resolve(path.dirname(file), m[1]);
    if (!target.endsWith('.js')) target = fs.existsSync(`${target}.js`) ? `${target}.js` : path.join(target, 'index.js');
    if (fs.existsSync(target)) reach(target, stops, seen);
  }
  return seen;
}

test('trade feedback invariance: no module that decides, nor the fail-closed review hook, reaches the feedback but through the runner\'s prompt', () => {
  const lib = path.join(D.ROOT, 'scripts', 'lib');
  const FB = path.join(lib, 'trading', 'trade-feedback.js');
  // The runner's prompt is the one way in (the runner's factual reviews write the trip tags through trip-facts.js, a leaf);
  // the cycle log the recorder.
  const stops = ['runner.js', 'runner-wiring.js', 'autotrader.js', 'cycle-log.js'].map(f => path.join(lib, f));
  const deciders = [
    'trading/order-gate.js', 'trading/mcp-gateway.js', 'trading/account-gate.js', 'trading/check-order.js', 'trading/trade-lifecycle.js',
    'trading/composed-reads.js', 'trading/lifecycle-gate.js', 'trading/lifecycle-order.js', 'trading/order-plan.js', 'trading/reasons.js',
    'trading/fact-claims.js', 'trading/verdict-stage.js', 'trading/combine.js', 'trading/prop-state.js', 'trading/rulebook.js', 'trading/mtf.js',
    'trading/briefing.js', 'trading/signal-state.js', 'prop/verdict.js', 'prop/size-translate.js', 'prop/composed-verdict.js', 'harness-tools/order-plan.js', 'harness-tools/compose.js',
    'runner-entry.js', 'cycle-data.js', 'trading/exit-trail.js', 'trading/trail.js',
    // The fail-closed review hook's path (toolcall/rules.js requires runner-reviews.js for its count).
    'toolcall/rules.js', 'trading/runner-reviews.js',
  ].map(f => path.join(lib, f));
  for (const f of deciders) {
    assert.ok(fs.existsSync(f), f);
    assert.ok(!reach(f, stops).has(FB), `${path.relative(D.ROOT, f)} reaches trade-feedback.js`);
  }
  // The walk itself: the runner's prompt reaches it, so a decider requiring it would be caught.
  assert.ok(reach(path.join(lib, 'runner-wiring.js'), []).has(FB));
  // And at run time: the review hook's rule module and its count load without it.
  const probe = "const lib = process.argv[1]; require(lib + '/toolcall/rules.js'); require(lib + '/trading/runner-reviews.js'); process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(k => /trade-feedback|experience-log|lifecycle-record|instincts/.test(k))));";
  const out = require('child_process').spawnSync(process.execPath, ['-e', probe, lib], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(JSON.parse(out.stdout).filter(k => /trade-feedback/.test(k)), []);
});
