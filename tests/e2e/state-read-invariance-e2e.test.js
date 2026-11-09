'use strict';

/**
 * The head trader's STATE line is a record, never a decision (trading/state-read.js): the same entry cycle through the
 * production stack (the decision-path world: the live runner, the cycle glue, the real order gateway and the mock
 * exchange) with the line present and right, present and wrong, malformed, conflicting, and absent decides and acts
 * the same: the gate's decisions, order_plan's reply, the orders the broker saw, the position and its brackets, the
 * runner's decision history, the cycle's result, entry, facts check and composed records. Only the cycle log's
 * stateRead differs. And no module that decides (the gate, the gateway, compose_check and the composed reads, the
 * trend rule, order_plan, sizing, the runner's entry) can reach the module at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const exchange = require('../fixtures/mock-exchange');
const D = require('../fixtures/decision-path');
const { readBriefing } = require('../../scripts/lib/trading/briefing');

const { SETUP, FIRED_BAR, decisionAt } = D;
const RESULT = `CYCLE RESULT: executed - ${SETUP.strategy} ${SETUP.side} MNQ 1`;
const flip = { up: 'down', down: 'up', range: 'up' };

/** The briefing's own labels as a STATE line (or each flipped: a wrong read). */
function stateFrom(w, wrong = false) {
  const b = readBriefing(w.home, 'MNQ').sections;
  const f = t => (wrong ? flip[t] || 'up' : t || 'unknown');
  return `STATE: 4h ${f(b.h1.data.h4.trend)} | 1h ${f(b.h1.data.h1.trend)} | 15m ${f(b.m15.data.frame.trend)} | frames ${wrong ? 'agree' : 'disagree'}`;
}

const VARIANTS = {
  absent: () => `PLAN:\n1 HTF: ...\n${RESULT}`,
  right: w => `PLAN:\n1 HTF: ...\n${stateFrom(w)}\n${RESULT}`,
  wrong: w => `PLAN:\n1 HTF: ...\n${stateFrom(w, true)}\n${RESULT}`,
  malformed: () => `PLAN:\n1 HTF: ...\nSTATE: everything looks bullish (4h up!!)\n${RESULT}`,
  conflicting: () => `PLAN:\n1 HTF: ...\nSTATE: 4h up | 1h up\nSTATE: 4h down | 1h up\n${RESULT}`,
};

// Wall-clock and per-run fields (times, ids of the tmp home, durations): never what was decided.
const VOLATILE = new Set(['ts', 'at', 'time', 'start', 'end', 'durationMs', 'ms', 'writtenAt', 'builtAt', 'savedAt', 'file', 'transcript', 'liveFile', 'promptHash', 'creationTimestamp', 'updateTimestamp', 'timing', 'usage', 'stateRead', 'cycle', 'cycleId', 'id', 'orderId', 'session', 'sessionID', 'pid']);
function norm(x, home) {
  // The order's custom tag is per harness home (its salt): the same order, another home's tag.
  const plain = s => s.split(home).join('<home>').replace(/fth-[0-9a-f]{16}/g, 'fth-<tag>');
  return JSON.parse(JSON.stringify(x, (k, v) => (VOLATILE.has(k) ? undefined : typeof v === 'string' ? plain(v) : v)));
}

/** What a cycle decided and did: the gate, the plan, the broker, the runner's record, the cycle log's outcome. */
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

test('state read invariance: present, wrong, malformed, conflicting or absent, the entry cycle decides and acts the same; only the record differs', { timeout: 600000 }, async () => {
  const got = {};
  for (const [name, final] of Object.entries(VARIANTS)) {
    const w = D.world();
    const r = await D.pass(w, decisionAt(FIRED_BAR), D.entryCycle(w, { result: () => final(w) }));
    got[name] = { decided: decided(w, r), state: D.cycleLines(w).at(-1).stateRead };
  }
  // The order went, as the decision path's own entry test has it, in every variant.
  assert.strictEqual(got.absent.decided.gate.filter(g => /place_order/.test(String(g.tool))).at(-1).decision, 'allowed');
  assert.ok(got.absent.decided.broker.some(c => c.tool === 'place_order'));
  for (const name of Object.keys(VARIANTS)) assert.deepStrictEqual(got[name].decided, got.absent.decided, `${name}: decided and acted as without the line`);
  // The record is what differs.
  assert.deepStrictEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.state.status])), { absent: 'none', right: 'read', wrong: 'read', malformed: 'unparsable', conflicting: 'conflicting' });
  assert.strictEqual(got.right.state.counts.mismatch, 0);
  assert.ok(got.wrong.state.counts.mismatch >= 3, JSON.stringify(got.wrong.state.counts));
});

/**
 * Every scripts/ module a file reaches through its require calls (relative paths, lazy ones too), itself included,
 * never through `stop` (the cycle log: the recorder many modules require for its transcript parsers, whose
 * writeCycleLog alone computes the record and writes it to the log).
 */
function reach(file, stop, seen = new Set()) {
  if (seen.has(file) || file === stop) return seen;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    let target = path.resolve(path.dirname(file), m[1]);
    if (!target.endsWith('.js')) target = fs.existsSync(`${target}.js`) ? `${target}.js` : path.join(target, 'index.js');
    if (fs.existsSync(target)) reach(target, stop, seen);
  }
  return seen;
}

test('state read invariance: no module that decides reaches state-read.js, through any require', () => {
  const lib = path.join(D.ROOT, 'scripts', 'lib');
  const STATE = path.join(lib, 'trading', 'state-read.js');
  const deciders = [
    'trading/order-gate.js', 'trading/mcp-gateway.js', 'trading/account-gate.js', 'trading/check-order.js', 'trading/trade-lifecycle.js',
    'trading/composed-reads.js', 'trading/lifecycle-gate.js', 'trading/lifecycle-order.js', 'trading/order-plan.js', 'trading/reasons.js',
    'trading/fact-claims.js', 'trading/verdict-stage.js', 'trading/combine.js', 'trading/prop-state.js', 'trading/rulebook.js', 'trading/mtf.js',
    'trading/briefing.js', 'prop/verdict.js', 'prop/size-translate.js', 'prop/composed-verdict.js', 'harness-tools/order-plan.js', 'harness-tools/compose.js',
    'runner-entry.js', 'runner.js', 'cycle-data.js',
  ].map(f => path.join(lib, f));
  const LOG = path.join(lib, 'cycle-log.js');
  for (const f of deciders) {
    assert.ok(fs.existsSync(f), f);
    assert.ok(!reach(f, LOG).has(STATE), `${path.relative(D.ROOT, f)} reaches state-read.js`);
  }
  // The walk itself: the cycle log reaches it (the record), so a decider requiring it directly would be caught.
  assert.ok(reach(LOG, null).has(STATE));
  // Only the cycle log (the record) and the read report require it; the record's field is read only by what carries
  // it to the experience log and the report (the store's summary, the run's cycles, the line) and by the report.
  const naming = re => {
    const out = [];
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && re.test(fs.readFileSync(path.join(d, e.name), 'utf8')) && out.push(path.relative(D.ROOT, path.join(d, e.name)))));
    walk(path.join(D.ROOT, 'scripts'));
    return out.sort();
  };
  assert.deepStrictEqual(naming(/require\([^)]*state-read/), ['scripts/lib/cycle-log.js', 'scripts/lib/learning/read-accuracy.js']);
  // And no module but the recorder and the module itself names a way to the read: the head's own text, the record's
  // builder, the parser or the scorer (a decider calling require('../cycle-log').headOwnText would be one).
  assert.deepStrictEqual(naming(/\b(?:headOwnText|cycleStateRecord|cycleStateRead|parseStateLine|parseState|scoreState)\b/), ['scripts/lib/cycle-log.js', 'scripts/lib/trading/state-read.js']);
  assert.ok(!('cycleStateRecord' in require('../../scripts/lib/cycle-log')), 'the record\'s builder is the cycle log\'s own');
  assert.deepStrictEqual(naming(/\bstateRead\b/), ['scripts/lib/cycle-log.js', 'scripts/lib/learning/experience-log.js', 'scripts/lib/learning/read-accuracy.js', 'scripts/lib/learning/run-experience.js', 'scripts/lib/replay/store.js']);
});
