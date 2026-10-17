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

test('the shipped desk workflow is valid: the three analysts and risk-manager phase 1, the desk request, read-data and report-shape, one retry', () => {
  const all = W.loadWorkflows(ROOT);
  assert.deepStrictEqual(all.filter(w => !w.valid).map(w => [w.name, w.errors]), []);
  const desk = W.workflowNamed(ROOT, 'desk');
  assert.deepStrictEqual(desk.phases, [{ name: 'desk', parallel: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], request: 'desk', accept: ['read-data', 'report-shape'], retries: 1 }]);
  // The desk's roles are the desk the gate and the desk log expect (trading/desk-check.js).
  const { expectedRoles } = require('../../scripts/lib/trading/desk-check');
  assert.deepStrictEqual(desk.phases[0].parallel, expectedRoles({ action: 'trade', cycle: 'full' }));
});

test('loadWorkflows refuses an invalid document and says why; none is not an error', () => {
  const r = root({
    ok: doc('name: ok\ndescription: d\nphases:\n  - name: p\n    parallel: [risk-manager]\n    request: desk\n    accept: [read-data]\n    retries: 0'),
    bad: doc('name: other\nphases:\n  - name: p\n    parallel: [nobody]\n    request: nope\n    accept: [never]\n    retries: -1\n  - name: p\n    parallel: []\n    request: desk\n    accept: []\n    retries: 0'),
    empty: doc('name: empty\ndescription: d\nphases: []'),
    orders: doc('name: orders\ndescription: d\nphases:\n  - name: p\n    parallel: [trade-executor]\n    request: desk\n    accept: []\n    retries: 0'),
    strict: doc('name: strict\ndescription: d\nextra: 1\nphases:\n  - name: p\n    parallel: [risk-manager, risk-manager]\n    request: desk\n    accept: []\n    retires: 1\n    retries: 0'),
  });
  const by = Object.fromEntries(W.loadWorkflows(r).map(w => [w.name, w]));
  assert.strictEqual(by.ok.valid, true);
  assert.strictEqual(by.bad.valid, false);
  for (const m of [/name "other" must match its folder "bad"/, /description: required/, /"nobody" is no agent/, /request: one of desk/, /"never" is no check/, /retries: a whole number/, /"p" twice/, /phases\[1\]\.parallel: one or more roles/]) assert.ok(by.bad.errors.some(e => m.test(e)), String(m));
  assert.deepStrictEqual(by.empty.errors, ['phases: one or more required']);
  // Never the order role: a workflow run from code never places, changes or closes an order.
  assert.ok(by.orders.errors.some(e => /"trade-executor" holds order tools: a workflow never runs it/.test(e)), JSON.stringify(by.orders.errors));
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
