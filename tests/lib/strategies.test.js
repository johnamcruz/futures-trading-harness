'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadStrategies, validateStrategy, scan, strategyDirs, checkStrategyForOrder } = require('../../scripts/lib/trading/strategies');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
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

test('bundled strategies are all valid Markdown rules, the algoTraderBot ports included', () => {
  const { strategies, problems } = loadStrategies(ROOT, {});
  assert.deepStrictEqual(problems, []);
  for (const s of strategies) assert.deepStrictEqual(s.errors, [], `${s.name}: ${s.errors.join('; ')}`);
  // Every strategy is rules, except the policy strategies, which trade the rules strategies' setups.
  for (const s of strategies.filter(x => x.signal !== 'policy')) assert.strictEqual(s.signal, 'rules', `${s.name} is written as rules`);
  const portfolio = strategies.find(s => s.name === 'prop_portfolio_3m');
  const threeMinute = strategies.filter(s => s.signal === 'rules' && s.timeframe === '3m').map(s => s.name).sort();
  assert.deepStrictEqual([...portfolio.strategies].sort(), threeMinute, 'prop_portfolio_3m trades every 3-minute rules strategy');
  assert.deepStrictEqual(strategies.find(s => s.name === 'prop_flow_1m').strategies.sort(), strategies.filter(s => s.signal === 'rules' && s.timeframe === '1m').map(s => s.name).sort());
  assert.strictEqual(portfolio.account, 'topstep_100k');
  for (const port of ['orb', 'ema_cross', 'keltner', 'supertrend', 'bos', 'cisd_ote']) assert.ok(strategies.some(s => s.name === port), `no strategy for ${port}`);
  const old = validateStrategy({ name: 'x', description: 'x'.repeat(40), status: 'paper', instruments: ['MNQ'], timeframe: '3m', signal: 'orb', risk: { stop: 'atr:0.5', min_rr: 2 } }, '## When to Use\n## How It Works\n## Examples', 'x');
  assert.ok(old.some(e => /no longer a code detector/.test(e)));
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
  // Without its ADX rule (flat data has no trend).
  const noAdx = r => r.filter(x => !/^adx/.test(x));
  const looseRules = s => compileRules({ long: noAdx(s.rules.long), short: noAdx(s.rules.short) }).compiled;
  const loose = strategies.map(s => (s.name === 'orb' ? { ...s, filters: {}, compiledRules: looseRules(s), regimes: undefined } : s));
  const results = scan(loose, { bars }, { symbol: 'MNQ' });
  const orb = results.find(r => r.name === 'orb');
  assert.strictEqual(orb.direction, 'long');
  assert.strictEqual(orb.inSession, true);
  assert.strictEqual(orb.candidate, true);
  assert.ok(orb.stopDistance > 0);
  assert.strictEqual(results.find(r => r.name === 'cisd_ote').signal, 'rules');
  assert.strictEqual(results.find(r => r.name === 'cisd_ote').direction, null);
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
    'name: md_breakout', 'description: Markdown-only breakout test strategy, long when close crosses above the prior 5-bar high.',
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
  const regimes = { bos: ['trend'], cisd_ote: ['range', 'transition'] };
  const strategies = loadStrategies(ROOT, {}).strategies.map(s => (regimes[s.name] ? { ...s, regimes: regimes[s.name] } : s));
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

test('timeframes, empty sessions, and zero ATR stops are rejected', () => {
  const bad = VALID.replace('timeframe: 5m', 'timeframe: 0m').replace('  stop: manual', '  stop: atr:0') + '\nsessions: ["09:45-09:45@America/New_York"]';
  const { data, body } = parseFrontmatter(`---\n${bad}\n---\n${BODY}`);
  const errors = validateStrategy(data, body, 'extra');
  assert.ok(errors.some(e => /^timeframe/.test(e)), errors.join('; '));
  assert.ok(errors.some(e => /^sessions/.test(e)), errors.join('; '));
  assert.ok(errors.some(e => /^risk\.stop/.test(e)), errors.join('; '));
});

test('policy strategies: the prop keys live only on them, and their strategies must be valid rules on the same timeframe', () => {
  const base = { name: 'p', description: 'x'.repeat(40), status: 'paper', instruments: ['MNQ', 'NQ'], timeframe: '3m', signal: 'policy', strategies: ['ema_cross'], account: 'topstep_100k', exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, risk: { stop: 'strategy', min_rr: 2 } };
  const body = '## When to Use\n## How It Works\n## Examples';
  assert.deepStrictEqual(validateStrategy(base, body, 'p'), []);
  assert.ok(validateStrategy({ ...base, contracts: 'nano' }, body, 'p').some(e => /contracts: micro \| mini \| auto/.test(e)));
  assert.ok(validateStrategy({ ...base, risk: { stop: 'atr:1', min_rr: 2 } }, body, 'p').some(e => /risk.stop: strategy/.test(e)));
  assert.ok(validateStrategy({ ...base, exit: { target_r: 3 } }, body, 'p').some(e => /trail_activate_r/.test(e)));
  assert.ok(validateStrategy({ ...base, account: undefined }, body, 'p').some(e => /account:/.test(e)));
  assert.ok(validateStrategy({ ...base, sizing: { cushion_frac: 1.5 } }, body, 'p').some(e => /at most 1/.test(e)));
  const rules = { name: 'r', description: 'x'.repeat(40), status: 'paper', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules: { long: ['close > 1'] }, risk: { stop: 'atr:1', min_rr: 2 } };
  for (const k of ['account', 'sizing', 'policy', 'strategies', 'contracts']) {
    assert.ok(validateStrategy({ ...rules, [k]: k === 'sizing' ? { cushion_frac: 0.2 } : k === 'policy' ? { bundle: 'b' } : k === 'strategies' ? ['x'] : k === 'contracts' ? 'auto' : 'topstep_100k' }, body, 'r').some(e => e.startsWith(`${k}: only a policy strategy`)), k);
  }
  // Cross-checks against the other strategies, at load time.
  const dir = tmpDir();
  const write = (name, fm) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'STRATEGY.md'), `---\n${fm}\n---\n${body}\n`);
  };
  const head = n => [`name: ${n}`, `description: ${'x'.repeat(40)}`, 'status: paper', 'instruments: [MNQ, NQ]', 'signal: policy', 'account: topstep_100k',
    'exit:', '  trail_activate_r: 2', '  trail_giveback_r: 0.5', 'risk:', '  stop: strategy', '  min_rr: 2'];
  write('p_ok', [...head('p_ok'), 'timeframe: 3m', 'strategies: [ema_cross, keltner]'].join('\n'));
  write('p_tf', [...head('p_tf'), 'timeframe: 3m', 'strategies: [ofi]'].join('\n'));
  write('p_none', [...head('p_none'), 'timeframe: 3m', 'strategies: [nope]'].join('\n'));
  write('p_es', [...head('p_es'), 'timeframe: 3m', 'strategies: [vwap_reclaim]'].join('\n').replace('instruments: [MNQ, NQ]', 'instruments: [MYM, YM]'));
  write('off_rules', ['name: off_rules', `description: ${'x'.repeat(40)}`, 'status: disabled', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules', 'rules:', '  long:', '    - close > 1', 'risk:', '  stop: atr:1', '  min_rr: 2'].join('\n'));
  write('p_off', [...head('p_off'), 'timeframe: 3m', 'strategies: [off_rules]'].join('\n'));
  const { strategies } = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: dir });
  const by = n => strategies.find(s => s.name === n);
  assert.strictEqual(by('p_ok').valid, true, by('p_ok').errors.join());
  assert.match(by('p_tf').errors.join(), /ofi trades 1m bars, not 3m/);
  assert.match(by('p_none').errors.join(), /nope is not a strategy/);
  assert.match(by('p_es').errors.join(), /none of its strategies trades MYM's index/);
  assert.match(by('p_off').errors.join(), /off_rules is disabled/);
});

test('mtf: trend (the default) or reversal; a policy strategy takes it from its setups; the reversal ports say so', () => {
  const base = ['name: x', 'description: A test strategy long enough to pass the description rule.', 'status: active', 'instruments: [MNQ]',
    'timeframe: 3m', 'signal: manual', 'risk:', '  stop: manual', '  min_rr: 1'];
  const errs = extra => validateStrategy(parseFrontmatter(`---\n${[...base, ...extra].join('\n')}\n---\n${BODY}`).data, BODY, 'x');
  assert.deepStrictEqual(errs([]), []);
  assert.deepStrictEqual(errs(['mtf: reversal']), []);
  assert.match(errs(['mtf: sideways']).join(), /mtf: trend \| reversal/);
  const { strategies } = loadStrategies(ROOT, {});
  const byName = Object.fromEntries(strategies.map(s => [s.name, s]));
  for (const n of ['crt_1h', 'crt_4h', 'cisd_ote', 'ofi_absorption']) assert.strictEqual(byName[n].mtf, 'reversal', n);
  for (const n of ['orb', 'ema_cross', 'keltner', 'supertrend', 'bos', 'vwap_reclaim', 'ofi']) assert.strictEqual(byName[n].mtf, 'trend', n);
  assert.strictEqual(byName.prop_portfolio_3m.mtf, undefined);
});

test('scan: a trend strategy that fires against the prevailing trend is not a candidate; a reversal one is', () => {
  const dir = tmpDir();
  const rules = style => [
    `name: ${style}_up`, `description: Fires long on every bar, a ${style} test of the multi-timeframe trend rule.`,
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules', `mtf: ${style}`,
    'rules:', '  long:', '    - volume > 0', 'risk:', '  stop: atr:1', '  min_rr: 2',
  ].join('\n');
  writeStrategy(dir, 'trend_up', rules('trend'));
  writeStrategy(dir, 'reversal_up', rules('reversal'));
  const mine = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: dir }).strategies.filter(s => /_up$/.test(s.name));
  // 6000 3-minute bars falling in waves: a 4h downtrend.
  const bars = Array.from({ length: 6000 }, (_, k) => {
    const c = 20000 - 0.3 * k + 40 * Math.sin((2 * Math.PI * k) / 320);
    return { t: new Date(Date.UTC(2026, 8, 1, 13) + k * 180000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 10 };
  });
  const r = Object.fromEntries(scan(mine, { bars }, { symbol: 'MNQ', now: new Date(Date.UTC(2026, 8, 13, 14)) }).map(x => [x.name, x]));
  assert.strictEqual(r.trend_up.direction, 'long');
  assert.strictEqual(r.trend_up.candidate, false);
  assert.ok(r.trend_up.filtersFailed.some(f => /^mtf: against the prevailing 4h down trend/.test(f)), r.trend_up.filtersFailed.join());
  assert.deepStrictEqual([r.trend_up.mtf.prevailing, r.trend_up.mtf.longAllowed, r.trend_up.mtf.shortAllowed], ['4h down', false, true]);
  assert.ok(!r.reversal_up.filtersFailed.some(f => /^mtf:/.test(f)));
  assert.strictEqual(r.reversal_up.mtf.style, 'reversal');
});

test('CLI scan reads CSV bars as well as get_bars JSON', () => {
  const out = [];
  run(['scan', path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'), '--symbol', 'MNQ', '--now', '2026-04-28T14:00:00Z'], { out: s => out.push(s) });
  const results = JSON.parse(out.join(''));
  assert.ok(results.length > 3 && results.every(x => x.name));
  assert.ok(results.some(x => x.mtf && x.mtf.ready), 'scan results carry the trend rule');
});

test('scan: each strategy that fired lists the others firing with it and against it on its timeframe', () => {
  const dir = tmpDir();
  const mk = (name, side) => writeStrategy(dir, name, [
    `name: ${name}`, `description: Fires ${side} on every bar, a confluence test strategy for the scan.`, 'status: active', 'instruments: [MNQ]',
    'timeframe: 3m', 'signal: rules', 'mtf: reversal', 'rules:', `  ${side}:`, '    - volume > 0', 'risk:', '  stop: atr:1', '  min_rr: 2',
  ].join('\n'));
  mk('up_a', 'long');
  mk('up_b', 'long');
  mk('down_c', 'short');
  const mine = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: dir }).strategies.filter(s => ['up_a', 'up_b', 'down_c'].includes(s.name));
  const bars = Array.from({ length: 60 }, (_, k) => ({ t: new Date(Date.UTC(2026, 9, 7, 14) + k * 180000).toISOString(), o: 100, h: 101, l: 99, c: 100 + (k % 3), v: 10 }));
  const r = Object.fromEntries(scan(mine, { bars }, { symbol: 'MNQ' }).map(x => [x.name, x]));
  assert.deepStrictEqual(r.up_a.confluence, { with: ['up_b'], against: ['down_c'] });
  assert.deepStrictEqual(r.down_c.confluence, { with: [], against: ['up_a', 'up_b'] });
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const p = prompts(validateConfig({ harness: 'qwen', eodAt: '15:50@America/New_York' }), new Date(), '/r')
    .trade([{ symbol: 'MNQ', bar: { t: bars[59].t, c: 100, file: '/f', contractId: 'C' }, scan: Object.values(r) }]);
  assert.match(p, /MNQ fired on this bar .*: down_c short; against up_a, up_b \| up_a long with up_b; against down_c/);
  assert.match(p, /Strategies disagree on the side: stand aside/);
});

test('recent: what fired on each of the last bars, as the scan judged each at its close', () => {
  const { recentSignals } = require('../../scripts/lib/trading/strategies');
  const out = [];
  run(['recent', path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'), '--symbol', 'MNQ', '--bars', '3'], { out: s => out.push(s) });
  const rows = JSON.parse(out.join(''));
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[1], { bar: '2026-04-28T04:09:00.000Z', fired: ['bos long', 'ema_cross long'] });
  assert.ok(typeof recentSignals === 'function');
  assert.throws(() => run(['recent', path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'), '--bars', '99'], { out: () => {} }), /--bars: 1 to 50/);
});

test('snapshot context: the numbers the skip rules talk about', () => {
  const { snapshot } = require('../../scripts/lib/trading/market-snapshot');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const c = snapshot(readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'))).context;
  for (const k of ['emaCrossesLast30', 'adxFallingBars', 'keltnerWidthVsAvg20', 'supertrendFlipsLast20', 'range5Atr', 'session', 'flow']) assert.ok(k in c, k);
  assert.ok(Number.isInteger(c.emaCrossesLast30) && c.session.high >= c.session.low);
  assert.strictEqual(c.flow.real, false, 'no buy/sell volume in this file: the flow is the bar-shape estimate');
});
