'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadStrategies, validateStrategy, scan, strategyDirs, SIGNALS } = require('../../scripts/lib/trading/strategies');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { snapshot } = require('../../scripts/lib/trading/market-snapshot');
const { run } = require('../../scripts/strategies');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BODY = '## When to Use\n## How It Works\n## Examples\n';

function writeStrategy(dir, name, fm, body = BODY) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'STRATEGY.md'), `---\n${fm}\n---\n${body}`);
}

const VALID = [
  'name: extra', 'description: A user strategy that lives outside the plugin folder for testing.',
  'status: paper', 'instruments: [MES]', 'timeframe: 5m', 'signal: manual', 'risk:', '  stop: manual', '  min_rr: 1.5',
].join('\n');

test('bundled strategies are all valid and cover every snapshot signal', () => {
  const { strategies, problems } = loadStrategies(ROOT, {});
  assert.deepStrictEqual(problems, []);
  for (const s of strategies) assert.deepStrictEqual(s.errors, [], `${s.name}: ${s.errors.join('; ')}`);
  const signals = Object.keys(snapshot(Array.from({ length: 5 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 7, 14, i)).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 }))).signals);
  assert.deepStrictEqual([...SIGNALS].filter(s => s !== 'manual').sort(), [...signals].sort());
  for (const sig of signals) assert.ok(strategies.some(s => s.signal === sig), `no strategy uses signal ${sig}`);
});

test('the template parses and only fails on its placeholder name', () => {
  const file = path.join(ROOT, 'strategies', '_template', 'STRATEGY.md');
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(validateStrategy(data, body, 'my_strategy'), []);
});

test('validation reports every schema problem', () => {
  const errors = validateStrategy({
    name: 'Bad Name', description: 'short', status: 'live', instruments: ['mnq'], timeframe: '3 min', signal: 'rsi',
    sessions: ['9-10'], filters: { adx_minimum: 3 }, params: { nope: 1 }, risk: { stop: 'tight' },
  }, '', 'bad');
  for (const frag of ['name:', 'must match its folder', 'description', 'status', 'instruments', 'timeframe', 'signal',
    'sessions', 'filters.adx_minimum', 'params.nope', 'risk.stop', 'risk.min_rr', 'When to Use']) {
    assert.ok(errors.some(e => e.includes(frag)), `expected an error mentioning ${frag}: ${errors.join(' | ')}`);
  }
});

test('extra strategy directories load, cannot shadow bundled names, and templates are skipped', () => {
  const dir = tmpDir();
  writeStrategy(dir, 'extra', VALID);
  writeStrategy(dir, 'orb', VALID.replace('name: extra', 'name: orb'));
  writeStrategy(dir, '_draft', VALID.replace('name: extra', 'name: _draft'));
  writeStrategy(dir, 'broken', 'name: broken\nthis is not yaml');
  const { strategies, problems } = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: dir });
  assert.ok(strategies.find(s => s.name === 'extra').valid);
  assert.strictEqual(strategies.find(s => s.name === 'orb').file, path.join(ROOT, 'strategies', 'orb', 'STRATEGY.md'));
  assert.ok(problems.some(p => /duplicate strategy "orb"/.test(p.error)));
  assert.ok(!strategies.some(s => s.name === '_draft'));
  assert.strictEqual(strategies.find(s => s.name === 'broken').valid, false);
  assert.deepStrictEqual(strategyDirs('/p', { FTH_STRATEGIES_DIRS: ' /a , /b ' }), [path.join('/p', 'strategies'), '/a', '/b']);
});

test('scan reports mechanical candidates with filters and sessions, and lists manual strategies', () => {
  const bars = [];
  let t = Date.UTC(2026, 9, 6, 22, 0);
  const push = (o, h, l, c) => { bars.push({ t: new Date(t).toISOString(), o, h, l, c, v: 100 }); t += 180000; };
  while (t < Date.UTC(2026, 9, 7, 13, 30)) push(100, 100.5, 99.5, 100);
  for (let i = 0; i < 5; i += 1) push(100, 101, 99, 100);
  push(100, 101.2, 99.9, 100.8);
  push(100.8, 102, 100.7, 101.9); // closes above the 101 OR high at 09:48 ET
  const { strategies } = loadStrategies(ROOT, {});
  const loose = strategies.map(s => (s.name === 'orb' ? { ...s, filters: {}, params: { orbAdx: 0 } } : s));
  const results = scan(loose, { bars }, { symbol: 'MNQ' });
  const orb = results.find(r => r.name === 'orb');
  assert.strictEqual(orb.direction, 'long');
  assert.strictEqual(orb.inSession, true);
  assert.strictEqual(orb.candidate, true);
  assert.ok(orb.stopDistance > 0);
  assert.strictEqual(results.find(r => r.name === 'cisd_ote').signal, 'manual');
  assert.deepStrictEqual(scan(loose, { bars }, { symbol: 'MCL' }), []);
  const strict = scan(strategies, { bars }, { symbol: 'MNQ' }).find(r => r.name === 'orb');
  assert.strictEqual(strict.candidate, false); // ADX gate fails on flat data
});

test('CLI list, show, validate, and errors', () => {
  let out = '';
  const capture = s => { out += s; };
  assert.strictEqual(run(['list', '--json'], { env: {}, out: capture }), 0);
  assert.ok(JSON.parse(out).some(s => s.name === 'orb'));
  out = '';
  run(['show', 'orb'], { env: {}, out: capture });
  assert.match(out, /^---\nname: orb/);
  out = '';
  assert.strictEqual(run(['validate'], { env: {}, out: capture }), 0);
  const dir = tmpDir();
  writeStrategy(dir, 'broken', 'name: broken');
  assert.strictEqual(run(['validate'], { env: { FTH_STRATEGIES_DIRS: dir }, out: () => {} }), 1);
  assert.throws(() => run(['show', 'nope'], { env: {}, out: capture }), /unknown strategy/);
  assert.throws(() => run(['bogus'], { env: {}, out: capture }), /usage/);
});
