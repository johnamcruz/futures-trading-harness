'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const W = require('../../scripts/lib/orchestrate/workflows');
const { createRun } = require('../../scripts/lib/orchestrate/engine');

const ROOT = path.resolve(__dirname, '..', '..');
const doc = fm => `---\n${fm}\n---\n\nbody\n`;

function root(files) {
  const r = tmpDir();
  fs.mkdirSync(path.join(r, 'agents'));
  for (const a of ['market-structure-analyst', 'risk-manager']) fs.writeFileSync(path.join(r, 'agents', `${a}.md`), '---\nname: x\ntools: Read, mcp__harness__bar_briefing\n---\n');
  fs.writeFileSync(path.join(r, 'agents', 'trade-executor.md'), '---\nname: trade-executor\ntools: Read, mcp__broker__place_order, mcp__broker__close_position\n---\n');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(r, 'workflows', name), { recursive: true });
    fs.writeFileSync(path.join(r, 'workflows', name, 'WORKFLOW.md'), text);
  }
  return r;
}

test('the shipped desk workflow is valid: the three analysts and risk-manager phase 1, the desk request, read-data, report-shape and lookups, one retry', () => {
  const all = W.loadWorkflows(ROOT);
  assert.deepStrictEqual(all.filter(w => !w.valid).map(w => [w.name, w.errors]), []);
  const desk = W.workflowNamed(ROOT, 'desk');
  assert.deepStrictEqual(desk.phases, [{ name: 'desk', parallel: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], request: 'desk', accept: ['read-data', 'report-shape', 'lookups'], retries: 1 }]);
  // The desk's roles are the desk the gate and the desk log expect (trading/desk-check.js).
  const { expectedRoles } = require('../../scripts/lib/trading/desk-check');
  assert.deepStrictEqual(desk.phases[0].parallel, expectedRoles({ action: 'trade', cycle: 'full' }));
});

test('runWorkflow: the desk\'s lookups check reads the ctx\'s requirement: a run missing one is retried, then reported missing; one with them is accepted', async () => {
  const desk = W.workflowNamed(ROOT, 'desk');
  const runs = { 'market-structure-analyst': 0, 'trend-momentum-analyst': 0 };
  const engine = {
    async run(role) {
      runs[role] += 1;
      // The structure analyst looks up what its bar requires on its second try; the trend analyst never does.
      const lookups = role === 'market-structure-analyst' && runs[role] === 2 ? ['breakout'] : [];
      return { ok: true, text: '## X\nData: bar_briefing m3@1', tools: ['harness_bar_briefing'], lookups };
    },
  };
  const ctx = { symbol: 'MNQ', at: '10:03 ET', timeframe: 3, lookups: { 'market-structure-analyst': ['breakout'], 'trend-momentum-analyst': ['cisd'] } };
  const res = await W.runWorkflow(desk, { run: createRun({ engine }), ctx, roles: ['market-structure-analyst', 'trend-momentum-analyst'], concurrency: 2 });
  const results = res.phases[0].results;
  assert.deepStrictEqual(results.map(r => [r.role, r.stop, r.attempts]), [['market-structure-analyst', 'completed', 2], ['trend-momentum-analyst', 'invalid', 2]]);
  assert.strictEqual(results[1].why, 'didn\'t look up cisd (this bar requires it of its role)');
});

test('loadWorkflows refuses an invalid document and says why; none is not an error', () => {
  const r = root({
    ok: doc('name: ok\ndescription: d\nphases:\n  - name: p\n    parallel: [risk-manager]\n    request: desk\n    accept: [read-data]\n    retries: 0'),
    bad: doc('name: other\nphases:\n  - name: p\n    parallel: [nobody]\n    request: nope\n    accept: [never]\n    retries: -1\n  - name: p\n    parallel: []\n    request: desk\n    accept: []\n    retries: 0'),
    empty: doc('name: empty\ndescription: d\nphases: []'),
    orders: doc('name: orders\ndescription: d\nphases:\n  - name: p\n    parallel: [trade-executor]\n    request: desk\n    accept: []\n    retries: 0'),
    // An orders phase: only the last, one role, the order role, no retry; and `orders` a boolean.
    last: doc('name: last\ndescription: d\nphases:\n  - name: x\n    parallel: [trade-executor]\n    request: execute\n    accept: []\n    retries: 0\n    orders: true\n  - name: y\n    parallel: [risk-manager]\n    request: desk\n    accept: []\n    retries: 0'),
    retry: doc('name: retry\ndescription: d\nphases:\n  - name: x\n    parallel: [trade-executor]\n    request: execute\n    accept: []\n    retries: 1\n    orders: true'),
    two: doc('name: two\ndescription: d\nphases:\n  - name: x\n    parallel: [trade-executor, risk-manager]\n    request: execute\n    accept: []\n    retries: 0\n    orders: true'),
    yes: doc('name: yes\ndescription: d\nphases:\n  - name: x\n    parallel: [risk-manager]\n    request: execute\n    accept: []\n    retries: 0\n    orders: "yes"'),
    exec: doc('name: exec\ndescription: d\nphases:\n  - name: r\n    parallel: [risk-manager]\n    request: review\n    accept: [verdict-facts]\n    retries: 1\n  - name: x\n    parallel: [trade-executor]\n    request: execute\n    accept: [order-sent]\n    retries: 0\n    orders: true'),
    strict: doc('name: strict\ndescription: d\nextra: 1\nphases:\n  - name: p\n    parallel: [risk-manager, risk-manager]\n    request: desk\n    accept: []\n    retires: 1\n    retries: 0'),
  });
  const by = Object.fromEntries(W.loadWorkflows(r).map(w => [w.name, w]));
  assert.strictEqual(by.ok.valid, true);
  assert.strictEqual(by.bad.valid, false);
  for (const m of [/name "other" must match its folder "bad"/, /description: required/, /"nobody" is no agent/, /request: one of desk/, /"never" is no check/, /retries: a whole number/, /"p" twice/, /phases\[1\]\.parallel: one or more roles/]) assert.ok(by.bad.errors.some(e => m.test(e)), String(m));
  assert.deepStrictEqual(by.empty.errors, ['phases: one or more required']);
  // Never the order role, unless the last phase declares orders: true (one role, no retry: at most one order).
  assert.ok(by.orders.errors.some(e => /"trade-executor" holds order tools: a workflow runs it only in a last phase that declares orders: true/.test(e)), JSON.stringify(by.orders.errors));
  assert.ok(by.last.errors.some(e => /phases\[0\]\.orders: only the last phase runs the order role/.test(e)), JSON.stringify(by.last.errors));
  assert.ok(by.retry.errors.some(e => /retries must be 0 \(a retry could send a second entry\)/.test(e)), JSON.stringify(by.retry.errors));
  assert.ok(by.two.errors.some(e => /exactly one role/.test(e)) && by.two.errors.some(e => /"risk-manager" holds no order tools/.test(e)), JSON.stringify(by.two.errors));
  assert.ok(by.yes.errors.some(e => /orders: true or false/.test(e)), JSON.stringify(by.yes.errors));
  assert.deepStrictEqual([by.exec.valid, by.exec.errors], [true, []]);
  // Strict: an unknown key, a misspelt one, a role twice.
  for (const m of [/extra: not a workflow key/, /phases\[0\]\.retires: not a phase key/, /risk-manager twice/]) assert.ok(by.strict.errors.some(e => m.test(e)), String(m));
  assert.strictEqual(W.workflowNamed(r, 'bad'), null);
  assert.deepStrictEqual(W.loadWorkflows(tmpDir()), []);
});

test('runWorkflow: each phase\'s roles with their request and checks, only those still to run when given; a role\'s failure is a result, ok only when all completed', async () => {
  const desk = W.workflowNamed(ROOT, 'desk');
  const seen = [];
  const engine = {
    async run(role, request) {
      seen.push([role, request]);
      if (role === 'risk-manager') return { ok: true, text: '## Risk state: account 1', tools: ['broker_get_account_snapshot'] };
      if (role === 'volume-liquidity-analyst') return { ok: true, text: 'Data: bar_briefing m3@1', tools: ['harness_skill_lookup'] }; // read no data
      return { ok: true, text: '## X\nData: bar_briefing m3@1', tools: ['harness_bar_briefing'] };
    },
  };
  const ctx = { symbol: 'MNQ', at: '10:03 ET', timeframe: 3 };
  const res = await W.runWorkflow(desk, { run: createRun({ engine }), ctx, roles: ['trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], concurrency: 2 });
  assert.deepStrictEqual(seen.map(s => s[0]).sort(), ['risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'volume-liquidity-analyst'].sort(), 'the cached one not run; the failing one retried once');
  const results = res.phases[0].results;
  assert.deepStrictEqual(results.map(r => [r.role, r.stop]), [['trend-momentum-analyst', 'completed'], ['volume-liquidity-analyst', 'invalid'], ['risk-manager', 'completed']]);
  assert.strictEqual(results[1].why, 'read no data');
  assert.strictEqual(res.ok, false);
  assert.ok(seen.every(([, req]) => /MNQ/.test(req) && !/already provided/i.test(req)));
  await assert.rejects(W.runWorkflow(null, { run: createRun({ engine }) }), TypeError);
});

test('runWorkflow: before(phase, phases) runs between the phases: it adds to the ctx a later phase\'s request reads, or stops the rest (stopped, ok false); the entry workflow\'s order phase runs only on its word', async () => {
  const entry = W.workflowNamed(ROOT, 'entry');
  assert.deepStrictEqual(entry.phases.map(p => [p.name, p.parallel, p.orders === true, p.retries]), [['review', ['risk-manager'], false, 1], ['execute', ['trade-executor'], true, 0]]);
  const seen = [];
  const engine = {
    async run(role, request) {
      seen.push([role, request]);
      if (role === 'risk-manager') return { ok: true, text: 'VERDICT: APPROVE - size 1\nFACTS: window asia; trend long allowed', tools: ['harness_order_plan'] };
      return { ok: true, text: 'EXECUTED', tools: ['broker_place_order'] };
    },
  };
  const ctx = { symbol: 'MNQ', at: 'x', timeframe: 3, strategy: 'trade_lifecycle', side: 'long', record: 'rec', reports: [] };
  const calls = [];
  const before = async (p, phases) => {
    calls.push([p.name, phases.map(x => x.name)]);
    return p.orders ? { ctx: { args: { size: 1, rationale: 'setup:trade_lifecycle long' }, verdict: 'VERDICT: APPROVE - size 1' } } : null;
  };
  const res = await W.runWorkflow(entry, { run: createRun({ engine }), ctx, concurrency: 1, before });
  assert.deepStrictEqual(calls, [['review', []], ['execute', ['review']]]);
  assert.deepStrictEqual(seen.map(s => s[0]), ['risk-manager', 'trade-executor']);
  assert.ok(seen[1][1].includes('{"size":1,"rationale":"setup:trade_lifecycle long"}'), 'the request reads what before() built');
  assert.deepStrictEqual([res.ok, res.stopped], [true, null]);
  // A stop: the order phase never runs.
  seen.length = 0;
  const stopped = await W.runWorkflow(entry, { run: createRun({ engine }), ctx, concurrency: 1, before: async p => (p.orders ? { stop: 'VERDICT: VETO - room' } : null) });
  assert.deepStrictEqual(seen.map(s => s[0]), ['risk-manager']);
  assert.deepStrictEqual([stopped.ok, stopped.stopped, stopped.phases.map(p => p.name)], [false, { phase: 'execute', why: 'VERDICT: VETO - room' }, ['review']]);
  // An executor that reports no order is invalid and never run again (retries 0).
  seen.length = 0;
  const lazy = { async run(role) { seen.push([role]); return role === 'risk-manager' ? { ok: true, text: 'VERDICT: APPROVE - size 1\nFACTS: news clear; entries allowed', tools: ['harness_order_plan'] } : { ok: true, text: 'done', tools: [] }; } };
  const once = await W.runWorkflow(entry, { run: createRun({ engine: lazy }), ctx, concurrency: 1, before });
  assert.deepStrictEqual(seen.map(s => s[0]), ['risk-manager', 'trade-executor']);
  assert.deepStrictEqual([once.phases[1].results[0].stop, once.phases[1].results[0].why, once.phases[1].results[0].attempts], ['invalid', 'no order call and no refusal reported', 1]);
  await assert.rejects(W.runWorkflow(entry, { run: createRun({ engine }), ctx, concurrency: 1, before: 'no' }), TypeError);
});
