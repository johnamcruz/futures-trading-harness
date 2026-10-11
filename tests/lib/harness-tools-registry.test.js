'use strict';

// The harness-tools server's tools (scripts/lib/harness-tools/registry.js): one per operation,
// strict schemas, no path, environment or time arguments, and nothing the order gate guards.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SERVER_NAME, TOOLS, BY_NAME, listTools } = require('../../scripts/lib/harness-tools/registry');
const { OPERATIONS } = require('../../scripts/lib/harness-tools/index');
const { validate } = require('../../scripts/lib/harness-tools/validate');

const ROOT = path.resolve(__dirname, '..', '..');
const NAMES = ['strategies_list', 'strategies_show', 'strategies_validate', 'strategies_scan', 'strategies_recent', 'market_snapshot', 'mtf_read',
  'blackouts_list', 'blackouts_add', 'bars_fetch', 'combine_status', 'lessons', 'reconcile'];

test('registry: the server is "harness", with one tool per operation', () => {
  assert.strictEqual(SERVER_NAME, 'harness');
  assert.deepStrictEqual(TOOLS.map(t => t.name), NAMES);
  assert.deepStrictEqual(TOOLS.map(t => t.op).sort(), Object.keys(OPERATIONS).sort(), 'every operation, once');
  for (const t of TOOLS) {
    assert.strictEqual(typeof OPERATIONS[t.op], 'function', t.name);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', `${t.script}.js`)), `${t.name}: the CLI tag is a real script`);
    assert.ok(t.description && t.narrow, t.name);
  }
  assert.deepStrictEqual(listTools().map(t => Object.keys(t)), TOOLS.map(() => ['name', 'description', 'inputSchema']));
  assert.strictEqual(BY_NAME.get('__proto__'), undefined);
});

test('registry: every schema is a closed object; no environment, cwd, output, time, or free-form path argument', () => {
  const walk = (s, at) => {
    if (s.type === 'object') assert.strictEqual(s.additionalProperties, false, `${at}: additionalProperties false`);
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${at}.${k}`);
    if (s.items) walk(s.items, `${at}[]`);
  };
  for (const t of TOOLS) {
    walk(t.inputSchema, t.name);
    assert.strictEqual(t.inputSchema.type, 'object');
    const props = Object.keys(t.inputSchema.properties);
    for (const banned of ['env', 'cwd', 'out', 'now', 'path', 'file', 'dir', 'root', 'home']) assert.ok(!props.includes(banned), `${t.name} takes no ${banned}`);
    // The only path arguments are bars files, and each is checked (tool.bars).
    for (const p of props) if (t.inputSchema.properties[p].description && /absolute path/.test(t.inputSchema.properties[p].description)) assert.ok((t.bars || []).includes(p), `${t.name}.${p} is checked as a bars file`);
  }
  assert.deepStrictEqual(TOOLS.filter(t => t.bars).map(t => [t.name, t.bars]), [
    ['strategies_scan', ['bars']], ['strategies_recent', ['bars']], ['market_snapshot', ['bars']], ['mtf_read', ['bars', 'daily']],
  ]);
});

test('registry: no tool is an order tool, and the order gate hook matches none of them', () => {
  for (const t of TOOLS) assert.doesNotMatch(t.name, /(place_order|modify_order|cancel_order|close_position)$/);
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const gate = (hooks.PreToolUse || []).filter(h => /place_order/.test(h.matcher));
  assert.ok(gate.length, 'the order-gate matcher exists');
  for (const h of gate) {
    for (const t of TOOLS) assert.ok(!new RegExp(h.matcher).test(`mcp__harness__${t.name}`), `${h.matcher} vs ${t.name}`);
  }
});

test('registry: the schemas take what the tools need and refuse the rest', () => {
  const ok = (name, args) => assert.deepStrictEqual(validate(BY_NAME.get(name).inputSchema, args), [], `${name} ${JSON.stringify(args)}`);
  const bad = (name, args, why) => assert.match(validate(BY_NAME.get(name).inputSchema, args).join('; '), why, `${name} ${JSON.stringify(args)}`);
  ok('strategies_list', {});
  ok('strategies_show', { name: 'orb' });
  bad('strategies_show', { name: '../orb' }, /must match/);
  bad('strategies_show', { name: '/etc/passwd' }, /must match/);
  ok('strategies_scan', { bars: '/tmp/fth/MNQ-3m.json', symbol: 'MNQ', record: true });
  bad('strategies_scan', { bars: '/tmp/fth/a.json', symbol: 'MNQ', now: '2026-01-01T00:00:00Z' }, /"now": unknown argument/);
  bad('strategies_scan', { bars: '/tmp/fth/a.json', symbol: 'mnq' }, /symbol: must match/);
  for (const symbol of ['MNQ\n../x', 'X\nMNQ', 'MNQ\n']) bad('strategies_scan', { bars: '/tmp/fth/a.json', symbol }, /symbol: must match/);
  bad('reconcile', { day: '2026-10-07\nx' }, /day: must match/);
  bad('combine_status', { account: 'topstep_50k\n../../x' }, /account: must match/);
  bad('strategies_recent', { bars: '/tmp/fth/a.json', symbol: 'MNQ', count: 51 }, /at most 50/);
  ok('market_snapshot', { bars: '/tmp/fth/a.json', params: { emaSlow: 30 } });
  bad('market_snapshot', { bars: '/tmp/fth/a.json', params: { bogus: 1 } }, /"params.bogus": unknown argument/);
  bad('market_snapshot', { bars: '/tmp/fth/a.json', params: { emaSlow: '30' } }, /must be a number/);
  bad('mtf_read', { bars: '/tmp/fth/a.json', timeframes: [15, 60, 240, 480, 720, 1440, 30] }, /at most 6 items/);
  bad('mtf_read', { bars: '/tmp/fth/a.json', timeframes: [1441] }, /at most 1440/);
  ok('blackouts_add', { start: '2026-10-07T12:25:00Z', end: '2026-10-07T12:40:00-04:00', reason: 'CPI' });
  bad('blackouts_add', { start: 'tomorrow', end: '2026-10-07T12:40:00Z', reason: 'CPI' }, /start: must match/);
  bad('blackouts_add', { start: '2026-10-07T12:25:00Z', end: '2026-10-07T12:40:00Z', reason: 'x'.repeat(121) }, /at most 120/);
  ok('bars_fetch', { symbol: 'MNQ', timeframe: 'daily', count: 60 });
  ok('bars_fetch', { symbol: 'MNQ', timeframe: 3 });
  bad('bars_fetch', { symbol: 'MNQ', timeframe: 61 }, /timeframe/);
  bad('bars_fetch', { symbol: 'MNQ', timeframe: 3, out: '/tmp/fth/x.json' }, /"out": unknown argument/);
  bad('bars_fetch', { symbol: 'MNQ', timeframe: 3, count: 20001 }, /at most 20000/);
  ok('combine_status', { account: 'topstep_50k', json: true });
  bad('combine_status', { account: '../x' }, /must match/);
  bad('lessons', { top: 0 }, /at least 1/);
  ok('reconcile', { day: '2026-10-07', timeframe: 3 });
  bad('reconcile', { day: '10/07' }, /must match/);
});

test('registry: arguments map to the operation\'s own', () => {
  const args = (name, input) => BY_NAME.get(name).args(input);
  assert.deepStrictEqual(args('strategies_scan', { bars: '/b.json', symbol: 'MNQ' }), { file: '/b.json', symbol: 'MNQ', record: false });
  assert.deepStrictEqual(args('mtf_read', { bars: '/b.json', timeframes: [15], daily: '/d.json', symbol: 'MNQ', record: true }), { file: '/b.json', tf: [15], daily: '/d.json', symbol: 'MNQ', json: false, record: true });
  assert.deepStrictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 'daily' }), { symbol: 'MNQ', timeframe: 3, daily: true, record: false });
  assert.deepStrictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 5, count: 10 }), { symbol: 'MNQ', timeframe: 5, daily: false, count: 10, record: false });
  // A role's own file: the default name with its suffix, under /tmp/fth.
  assert.strictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 15, name: 'trend' }).out, '/tmp/fth/MNQ-15m-trend.json');
  assert.strictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 'daily', name: 'structure' }).out, '/tmp/fth/MNQ-1d-structure.json');
  for (const name of ['../x', 'Trend', 'a/b', 'a.json', '', '-x', 'x'.repeat(25)]) {
    assert.match(validate(BY_NAME.get('bars_fetch').inputSchema, { symbol: 'MNQ', timeframe: 3, name }).join(), /name: (must match|at least)/, name);
  }
  assert.deepStrictEqual(args('market_snapshot', { bars: '/b.json' }), { file: '/b.json', params: {} });
  assert.deepStrictEqual(args('reconcile', { day: '2026-10-07' }), { day: '2026-10-07', json: false });
});
