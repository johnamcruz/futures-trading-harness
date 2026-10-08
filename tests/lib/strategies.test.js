'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadStrategies, validateStrategy, scan, strategyDirs, checkStrategyForOrder, BUILT_IN_SIGNALS } = require('../../scripts/lib/trading/strategies');
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
  assert.deepStrictEqual([...BUILT_IN_SIGNALS].sort(), [...signals].sort());
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
  const loose = strategies.map(s => (s.name === 'orb' ? { ...s, filters: {}, params: { orbAdx: 0 }, regimes: undefined } : s));
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

test('a rules strategy written only in Markdown validates and fires in scan', () => {
  const dir = tmpDir();
  writeStrategy(dir, 'md_breakout', [
    'name: md_breakout', 'description: Markdown-only breakout test strategy: close crosses above the prior 5-bar high.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules',
    'rules:', '  long:', '    - close crosses_above highest(5)[1]', '    - volume > 0',
    'risk:', '  stop: atr:1', '  min_rr: 2',
  ].join('\n'));
  writeStrategy(dir, 'md_broken', [
    'name: md_broken', 'description: Markdown rules with a typo in a series name should be invalid.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules',
    'rules:', '  long:', '    - close crosses_above hihgest(5)',
    'risk:', '  stop: atr:1', '  min_rr: 2',
  ].join('\n'));
  const { strategies } = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: dir });
  assert.match(strategies.find(s => s.name === 'md_broken').errors.join(), /unknown function "hihgest/);
  const md = strategies.filter(s => s.name === 'md_breakout');
  assert.ok(md[0].valid, md[0].errors.join());
  const t = i => new Date(Date.UTC(2026, 9, 7, 14, 0) + i * 180000).toISOString();
  // highest(5)[1] is the 5-bar high as of the previous bar, so a jump above it fires.
  const bars = [100, 100, 100, 100, 100, 100, 105].map((c, i) => ({ t: t(i), o: c, h: c, l: c, c, v: 10 }));
  const [r] = scan(md, { bars }, { symbol: 'MNQ' });
  assert.strictEqual(r.signal, 'rules');
  assert.ok(Array.isArray(r.rules.long));
  assert.strictEqual(r.rules.long[1].ok, true);
  assert.strictEqual(r.direction, 'long');
});

test('scan marks strategies out of regime and never makes them candidates', () => {
  const { strategies } = loadStrategies(ROOT, {});
  const t = i => new Date(Date.UTC(2026, 9, 7, 13, 30) + i * 180000).toISOString();
  const ranging = Array.from({ length: 160 }, (_, k) => { const c = 100 + Math.sin(k / 2) * 2; return { t: t(k), o: c, h: c + 1, l: c - 1, c, v: 1 }; });
  const results = scan(strategies, { bars: ranging }, { symbol: 'MNQ', now: new Date(Date.UTC(2026, 9, 7, 15, 0)) });
  const bos = results.find(r => r.name === 'bos');
  assert.strictEqual(bos.regime, 'range');
  assert.strictEqual(bos.inRegime, false);
  assert.strictEqual(bos.candidate, false);
  assert.strictEqual(results.find(r => r.name === 'cisd_ote').inRegime, true);
});

test('unknown keys, risk keys, and out-of-range params are rejected with hints', () => {
  const { data, body } = parseFrontmatter(`---\n${VALID}\nsesions: [rth]\nparams:\n  swingK: 0\n  orbMinutes: 2.5\n  stMult: -1\n  constructor_x: 1\n---\n${BODY}`);
  data.risk.minrr = 2;
  const errors = validateStrategy(data, body, 'extra');
  assert.ok(errors.some(e => /unknown key "sesions" \(did you mean sessions\?\)/.test(e)), errors.join('; '));
  assert.ok(errors.some(e => /risk\.minrr: unknown key \(did you mean min_rr\?\)/.test(e)), errors.join('; '));
  assert.ok(errors.some(e => /params\.swingK: a whole number/.test(e)));
  assert.ok(errors.some(e => /params\.orbMinutes: a whole number/.test(e)));
  assert.ok(errors.some(e => /params\.stMult: a number above 0/.test(e)));
  assert.ok(errors.some(e => /params\.constructor_x: unknown/.test(e)));
});

test('oversized files are refused and symlinked strategy folders are followed', () => {
  const dir = tmpDir();
  const real = tmpDir();
  writeStrategy(real, 'linked', VALID.replace('name: extra', 'name: linked'));
  fs.symlinkSync(path.join(real, 'linked'), path.join(dir, 'linked'));
  writeStrategy(dir, 'huge', VALID.replace('name: extra', 'name: huge'), BODY + 'x'.repeat(300 * 1024));
  const { strategies } = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: dir });
  const linked = strategies.find(s => s.name === 'linked');
  assert.ok(linked && linked.valid, 'symlinked folder loads');
  const huge = strategies.find(s => s.name === 'huge');
  assert.ok(huge && !huge.valid && /larger than/.test(huge.errors[0]));
});

test('one strategy that throws during a scan does not stop the others', () => {
  const b = Array.from({ length: 80 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 7, 14, i * 3)).toISOString(), o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 10 }));
  const good = { name: 'good', valid: true, status: 'active', instruments: ['MNQ'], sessions: [], signal: 'manual', risk: { stop: 'manual' } };
  const bad = { ...good, name: 'bad', signal: 'rules', compiledRules: null };
  const res = scan([bad, good], b, { symbol: 'MNQ' });
  assert.ok(res.find(r => r.name === 'bad').error);
  assert.ok(res.find(r => r.name === 'good'));
});

test('a rules strategy with no short rules cannot be used to sell into an entry', () => {
  const s = { name: 'longonly', valid: true, status: 'active', instruments: ['MNQ'], sessions: [], compiledRules: { long: [{}], short: [] } };
  const now = new Date(Date.UTC(2026, 9, 7, 15, 0));
  assert.match(checkStrategyForOrder([s], 'longonly', 'MNQ', now, 'sell'), /no short rules/);
  assert.strictEqual(checkStrategyForOrder([s], 'longonly', 'MNQ', now, 'buy'), null);
});
