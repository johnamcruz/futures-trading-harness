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
const NAMES = ['strategies_list', 'strategies_show', 'strategies_validate', 'strategies_scan', 'strategies_recent', 'order_plan', 'market_snapshot', 'mtf_read',
  'blackouts_list', 'blackouts_add', 'bars_fetch', 'combine_status', 'lessons', 'reconcile', 'bar_briefing', 'reason_check', 'skill_lookup', 'compose_check', 'experience_lookup'];

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
    ['strategies_scan', ['bars']], ['strategies_recent', ['bars']], ['order_plan', ['bars']], ['market_snapshot', ['bars']], ['mtf_read', ['bars', 'daily']],
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
  ok('strategies_scan', { bars: '/h/bars-scratch/MNQ-3m.json', symbol: 'MNQ', record: true });
  bad('strategies_scan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', now: '2026-01-01T00:00:00Z' }, /"now": unknown argument/);
  bad('strategies_scan', { bars: '/h/bars-scratch/a.json', symbol: 'mnq' }, /symbol: must match/);
  for (const symbol of ['MNQ\n../x', 'X\nMNQ', 'MNQ\n']) bad('strategies_scan', { bars: '/h/bars-scratch/a.json', symbol }, /symbol: must match/);
  bad('reconcile', { day: '2026-10-07\nx' }, /day: must match/);
  bad('combine_status', { account: 'test_50k\n../../x' }, /account: must match/);
  bad('strategies_recent', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', count: 51 }, /at most 50/);
  ok('order_plan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', strategy: 'bos', side: 'long', accountId: 7 });
  bad('order_plan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', strategy: 'bos' }, /side.*required|required.*side/);
  bad('order_plan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', side: 'long' }, /strategy.*required|required.*strategy/);
  bad('order_plan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', strategy: 'bos', side: 'buy' }, /side: must be one of/);
  bad('order_plan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', strategy: '../bos', side: 'long' }, /strategy: must match/);
  bad('order_plan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', strategy: 'bos', side: 'long', accountId: 0 }, /accountId: at least 1/);
  bad('order_plan', { bars: '/h/bars-scratch/a.json', symbol: 'MNQ', strategy: 'bos', side: 'long', size: 3 }, /"size": unknown argument/);
  assert.deepStrictEqual(BY_NAME.get('order_plan').args({ bars: '/b.json', symbol: 'MNQ', strategy: 'bos', side: 'long', accountId: 7 }), { file: '/b.json', symbol: 'MNQ', strategy: 'bos', side: 'long', accountId: 7 });
  ok('market_snapshot', { bars: '/h/bars-scratch/a.json', params: { emaSlow: 30 } });
  bad('market_snapshot', { bars: '/h/bars-scratch/a.json', params: { bogus: 1 } }, /"params.bogus": unknown argument/);
  bad('market_snapshot', { bars: '/h/bars-scratch/a.json', params: { emaSlow: '30' } }, /must be a number/);
  bad('mtf_read', { bars: '/h/bars-scratch/a.json', timeframes: [15, 60, 240, 480, 720, 1440, 30] }, /at most 6 items/);
  bad('mtf_read', { bars: '/h/bars-scratch/a.json', timeframes: [1441] }, /at most 1440/);
  ok('blackouts_add', { start: '2026-10-07T12:25:00Z', end: '2026-10-07T12:40:00-04:00', reason: 'CPI' });
  bad('blackouts_add', { start: 'tomorrow', end: '2026-10-07T12:40:00Z', reason: 'CPI' }, /start: must match/);
  bad('blackouts_add', { start: '2026-10-07T12:25:00Z', end: '2026-10-07T12:40:00Z', reason: 'x'.repeat(121) }, /at most 120/);
  ok('bars_fetch', { symbol: 'MNQ', timeframe: 'daily', count: 60 });
  ok('bars_fetch', { symbol: 'MNQ', timeframe: 3 });
  bad('bars_fetch', { symbol: 'MNQ', timeframe: 61 }, /timeframe/);
  bad('bars_fetch', { symbol: 'MNQ', timeframe: 3, out: '/h/bars-scratch/x.json' }, /"out": unknown argument/);
  bad('bars_fetch', { symbol: 'MNQ', timeframe: 3, count: 20001 }, /at most 20000/);
  ok('combine_status', { account: 'test_50k', json: true });
  bad('combine_status', { account: '../x' }, /must match/);
  bad('lessons', { top: 0 }, /at least 1/);
  ok('reconcile', { day: '2026-10-07', timeframe: 3 });
  bad('reconcile', { day: '10/07' }, /must match/);
});

test('registry: arguments map to the operation\'s own', () => {
  const args = (name, input) => BY_NAME.get(name).args(input);
  // The tools' compact forms by default; the full ones (the scripts') on request.
  assert.deepStrictEqual(args('strategies_scan', { bars: '/b.json', symbol: 'MNQ' }), { file: '/b.json', symbol: 'MNQ', record: false, view: 'summary' });
  assert.deepStrictEqual(args('strategies_scan', { bars: '/b.json', symbol: 'MNQ', detail: true }), { file: '/b.json', symbol: 'MNQ', record: false, view: 'json' });
  assert.deepStrictEqual(args('strategies_scan', { bars: '/b.json', symbol: 'MNQ', detail: false }), { file: '/b.json', symbol: 'MNQ', record: false, view: 'summary' });
  assert.deepStrictEqual(args('strategies_scan', { bars: '/b.json', symbol: 'MNQ', name: 'orb', detail: true, record: true }), { file: '/b.json', symbol: 'MNQ', name: 'orb', record: true, view: 'one' });
  for (const name of ['../x', 'a/b', '', 'x'.repeat(65)]) assert.match(validate(BY_NAME.get('strategies_scan').inputSchema, { bars: '/b.json', symbol: 'MNQ', name }).join(), /name: (must match|at least)/, name);
  assert.deepStrictEqual(args('strategies_recent', { bars: '/b.json', symbol: 'MNQ', count: 3 }), { file: '/b.json', symbol: 'MNQ', count: 3, format: 'lines' });
  assert.deepStrictEqual(args('strategies_recent', { bars: '/b.json', symbol: 'MNQ', json: true }), { file: '/b.json', symbol: 'MNQ', format: 'json' });
  assert.deepStrictEqual(args('strategies_list', {}), { compact: true });
  assert.deepStrictEqual(args('strategies_list', { json: true }), { json: true, compact: true });
  assert.deepStrictEqual(args('mtf_read', { bars: '/b.json', timeframes: [15], daily: '/d.json', symbol: 'MNQ', record: true }), { file: '/b.json', tf: [15], daily: '/d.json', symbol: 'MNQ', json: false, record: true });
  assert.deepStrictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 'daily' }), { symbol: 'MNQ', timeframe: 3, daily: true, record: false });
  assert.deepStrictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 5, count: 10 }), { symbol: 'MNQ', timeframe: 5, daily: false, count: 10, record: false });
  // A role's own file: the name goes to the operation, which puts the file in the caller's home (bars-fetch.js); never an out path.
  assert.deepStrictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 15, name: 'trend' }), { symbol: 'MNQ', timeframe: 15, daily: false, record: false, name: 'trend' });
  assert.deepStrictEqual(args('bars_fetch', { symbol: 'MNQ', timeframe: 'daily', name: 'structure' }), { symbol: 'MNQ', timeframe: 3, daily: true, record: false, name: 'structure' });
  for (const name of ['../x', 'Trend', 'a/b', 'a.json', '', '-x', 'x'.repeat(25)]) {
    assert.match(validate(BY_NAME.get('bars_fetch').inputSchema, { symbol: 'MNQ', timeframe: 3, name }).join(), /name: (must match|at least)/, name);
  }
  assert.deepStrictEqual(args('market_snapshot', { bars: '/b.json' }), { file: '/b.json', params: {}, compact: true });
  assert.deepStrictEqual(args('reconcile', { day: '2026-10-07' }), { day: '2026-10-07', json: false });
});

test('registry: every module OPERATIONS loads lazily loads under the committed config, and exports its function (a broken module fails here, not on the first live call)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'harness-tools', 'index.js'), 'utf8');
  const named = [...src.matchAll(/lazy\('([\w-]+)', '(\w+)'\)/g)].map(m => [m[1], m[2]]);
  assert.strictEqual(named.length, Object.keys(OPERATIONS).length, 'every operation names its module and function');
  for (const [file, name] of named) {
    let mod;
    assert.doesNotThrow(() => { mod = require(`../../scripts/lib/harness-tools/${file}`); }, `${file} loads`);
    assert.strictEqual(typeof mod[name], 'function', `${file}.${name}`);
  }
});
