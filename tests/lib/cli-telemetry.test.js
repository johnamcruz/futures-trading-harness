'use strict';

// disableCliTelemetry (the runner config; scripts/lib/autotrader.js CLI_TELEMETRY_ENV): Claude Code's CLI telemetry off
// for every run the runner starts, which removes the exit tail after a run's result. Static config, read at start;
// it changes no model input, tool, gate or prompt, so it is no head delivery key.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const A = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const { validateConfig, buildCommand, childEnv, CLI_TELEMETRY_ENV } = A;

const home = tmpDir();
const BASE = { FTH_HOME: home, HOME: home };
const cfgOf = extra => validateConfig({ harness: 'claude', timeframe: 3, dataDir: path.join(home, 'bars'), ...extra });
const sessionFile = path.join(home, 'prepare-session.json');
// One run of each kind the runner starts on the entry path and beside it.
const RUNS = {
  head: { action: 'trade', symbols: [] },
  desk_role: { action: 'trade', symbols: [], roleRun: 'market-structure-analyst' },
  phase2: { action: 'trade', symbols: [], roleRun: 'risk-manager' },
  executor: { action: 'trade', symbols: [], roleRun: 'trade-executor' },
  prepare: { action: 'trade', symbols: [], prepare: 'prepare', prepareSession: sessionFile },
  confirm: { action: 'trade', symbols: [], prepare: 'confirm', prepareSession: sessionFile },
};
// Per-run random names (the streamed transcript's file) aside, the env key for key.
const stable = e => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'FTH_CYCLE_TRANSCRIPT'));
const without = (e, k) => { const o = { ...stable(e) }; delete o[k]; return o; };

test('disableCliTelemetry (validation): a boolean, harness claude only, absent or false as before', () => {
  assert.strictEqual(validateConfig({ harness: 'claude', disableCliTelemetry: true }).disableCliTelemetry, true);
  assert.strictEqual(validateConfig({ harness: 'claude', disableCliTelemetry: false }).disableCliTelemetry, false);
  assert.ok(!('disableCliTelemetry' in validateConfig({ harness: 'claude' })), 'absent stays absent');
  for (const v of ['true', 1, 0, null, 'yes', {}]) assert.throws(() => validateConfig({ harness: 'claude', disableCliTelemetry: v }), /disableCliTelemetry: true or false/, String(v));
  for (const harness of ['opencode', 'codex', 'qwen']) {
    assert.throws(() => validateConfig({ harness, disableCliTelemetry: true }), /disableCliTelemetry: for harness "claude" only/, harness);
    assert.strictEqual(validateConfig({ harness, disableCliTelemetry: false }).disableCliTelemetry, false, `${harness}: false is as absent`);
    assert.ok(!('disableCliTelemetry' in validateConfig({ harness })), harness);
  }
});

test('disableCliTelemetry is no head delivery key: it changes no model input, so decisions pool across it', () => {
  assert.ok(!A.HEAD_DELIVERY_KEYS.includes('disableCliTelemetry'));
  assert.strictEqual(A.headDeliveryOf(null, cfgOf({ disableCliTelemetry: true })), A.headDeliveryOf(null, cfgOf({})));
});

test('on: DISABLE_TELEMETRY=1 in the env of the head trader, a desk role, phase 2, the executor, the prepare and the confirm', () => {
  assert.strictEqual(CLI_TELEMETRY_ENV, 'DISABLE_TELEMETRY');
  // Seeded with other values so the setter, not the inherited env, is what each run shows.
  for (const seed of [undefined, '0', 'inherited']) {
    const base = seed === undefined ? BASE : { ...BASE, [CLI_TELEMETRY_ENV]: seed };
    for (const [name, ctx] of Object.entries(RUNS)) {
      assert.strictEqual(childEnv(cfgOf({ disableCliTelemetry: true }), ROOT, base, ctx)[CLI_TELEMETRY_ENV], '1', `${name} (seed ${seed})`);
    }
    assert.strictEqual(childEnv(cfgOf({ disableCliTelemetry: true }), ROOT, base)[CLI_TELEMETRY_ENV], '1', 'no context');
  }
});

test('off or absent: the env has no such variable and is the same as a config without the key, run by run; on differs by it alone', () => {
  for (const [name, ctx] of Object.entries(RUNS)) {
    const absent = childEnv(cfgOf({}), ROOT, BASE, ctx);
    const off = childEnv(cfgOf({ disableCliTelemetry: false }), ROOT, BASE, ctx);
    const on = childEnv(cfgOf({ disableCliTelemetry: true }), ROOT, BASE, ctx);
    assert.ok(!(CLI_TELEMETRY_ENV in absent), `${name}: absent`);
    assert.ok(!(CLI_TELEMETRY_ENV in off), `${name}: false`);
    assert.deepStrictEqual(stable(off), stable(absent), name);
    assert.deepStrictEqual(without(on, CLI_TELEMETRY_ENV), stable(absent), `${name}: on differs by that variable alone`);
  }
});

test('off or absent leaves a machine-exported DISABLE_TELEMETRY exactly as inherited (byte-identical to today), and on overrides it to 1', () => {
  const seeded = { ...BASE, [CLI_TELEMETRY_ENV]: 'inherited-value' };
  for (const [name, ctx] of Object.entries(RUNS)) {
    assert.strictEqual(childEnv(cfgOf({}), ROOT, seeded, ctx)[CLI_TELEMETRY_ENV], 'inherited-value', `${name}: absent keeps it`);
    assert.strictEqual(childEnv(cfgOf({ disableCliTelemetry: false }), ROOT, seeded, ctx)[CLI_TELEMETRY_ENV], 'inherited-value', `${name}: false keeps it`);
    assert.strictEqual(childEnv(cfgOf({ disableCliTelemetry: true }), ROOT, seeded, ctx)[CLI_TELEMETRY_ENV], '1', `${name}: true sets 1`);
  }
});

test('never set for another harness (it is refused there; a raw cfg that carries it still gets none)', () => {
  for (const harness of ['opencode', 'codex', 'qwen']) {
    const env = childEnv({ ...validateConfig({ harness, dataDir: path.join(home, 'bars') }), disableCliTelemetry: true }, ROOT, BASE, RUNS.head);
    assert.ok(!(CLI_TELEMETRY_ENV in env), harness);
  }
});

test('the argv is unchanged by the key: the head trader, a role, the prepare and the confirm', () => {
  const on = cfgOf({ disableCliTelemetry: true });
  const off = cfgOf({});
  const runs = [{}, { agent: 'risk-manager' }, { prepare: 'prepare' }, { prepare: 'confirm', resume: 'ses-1' }];
  for (const opts of runs) {
    const a = buildCommand(on, 'P', ROOT, childEnv(on, ROOT, BASE, RUNS.head), opts);
    const b = buildCommand(off, 'P', ROOT, childEnv(off, ROOT, BASE, RUNS.head), opts);
    assert.deepStrictEqual(a, b, JSON.stringify(opts));
    assert.ok(!JSON.stringify(a).includes('TELEMETRY'), 'nothing of it in the command');
  }
});
