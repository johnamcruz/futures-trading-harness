'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadStrategies, validateStrategy, scan, strategyDirs, checkStrategyForOrder, tradesRoot, rootRefusal, recentSignals } = require('../../scripts/lib/trading/strategies');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { run } = require('../../scripts/strategies');
const { tmpDir, shippedPolicy, rootWithPolicies } = require('../helpers');

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

test('bundled strategies are all valid Markdown rules, the ported ones included', () => {
  const { strategies, problems } = loadStrategies(ROOT, {});
  assert.deepStrictEqual(problems, []);
  for (const s of strategies) assert.deepStrictEqual(s.errors, [], `${s.name}: ${s.errors.join('; ')}`);
  // Every strategy is rules, except the policy strategies, which trade the rules strategies' setups.
  for (const s of strategies.filter(x => x.signal !== 'policy')) assert.strictEqual(s.signal, 'rules', `${s.name} is written as rules`);
  const portfolio = strategies.find(s => s.name === 'prop_portfolio');
  const threeMinute = strategies.filter(s => s.signal === 'rules' && s.timeframe === '3m').map(s => s.name).sort();
  assert.deepStrictEqual([...portfolio.strategies].sort(), threeMinute, 'prop_portfolio trades every 3-minute rules strategy');
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

test('tradesRoot: a rules strategy trades the selected leg of a micro/mini family it lists, never the other; unknown selection: exactly its list', () => {
  const rules = list => ({ signal: 'rules', instruments: list });
  const micro = rules(['MNQ', 'MES']);
  // Selected MNQ: MNQ, not NQ. Selected NQ: NQ (listing MNQ covers it), not MNQ.
  assert.strictEqual(tradesRoot(micro, 'MNQ', ['MNQ']), true);
  assert.strictEqual(tradesRoot(micro, 'NQ', ['MNQ']), false);
  assert.strictEqual(tradesRoot(micro, 'NQ', ['NQ']), true);
  assert.strictEqual(tradesRoot(micro, 'nq', ['NQ']), true);
  assert.strictEqual(tradesRoot(micro, 'MNQ', ['NQ']), false);
  assert.strictEqual(rootRefusal(micro, 'MNQ', ['NQ', 'MES']), 'trades NQ (the selected contract), not MNQ');
  assert.strictEqual(rootRefusal(micro, 'NQ', ['MNQ']), 'trades MNQ (the selected contract), not NQ');
  // Listing both legs doesn't let it alternate: only the selected one.
  assert.strictEqual(tradesRoot(rules(['MNQ', 'NQ']), 'MNQ', ['NQ']), false);
  assert.strictEqual(tradesRoot(rules(['MNQ', 'NQ']), 'NQ', ['NQ']), true);
  // Each family by its own selection: ES selected, MNQ (no Nasdaq leg selected) is its list.
  assert.strictEqual(tradesRoot(micro, 'ES', ['ES']), true);
  assert.strictEqual(tradesRoot(micro, 'MES', ['ES']), false);
  assert.strictEqual(tradesRoot(micro, 'MNQ', ['ES']), true);
  assert.strictEqual(tradesRoot(micro, 'NQ', ['ES']), false);
  // Unknown selection, both legs listed: neither (which one is the user's to say).
  for (const r of ['MNQ', 'NQ']) assert.match(rootRefusal(rules(['MNQ', 'NQ']), r, null), /^lists both MNQ and NQ, and neither is selected: .*FTH_SYMBOLS=/, r);
  assert.strictEqual(tradesRoot(rules(['MNQ', 'NQ', 'MES']), 'MES', null), true, 'another family: its list');
  // Unknown selection (fails closed): exactly the roots listed, with how to select the other leg.
  assert.strictEqual(tradesRoot(micro, 'MNQ', null), true);
  assert.strictEqual(tradesRoot(micro, 'NQ', null), false);
  assert.match(rootRefusal(micro, 'NQ', null), /^does not trade NQ \(instruments: MNQ, MES\); .*select NQ \(the runner's symbols, or FTH_SYMBOLS=NQ\)$/);
  // Nothing outside its families, selected or not.
  for (const r of ['MYM', 'YM', 'GC', 'MGC', 'CL', 'MCL', '', null, undefined, 'MNQX', 'fake:ENQ:Z25']) {
    assert.strictEqual(tradesRoot(micro, r, [r ? String(r) : 'GC']), false, String(r));
    assert.strictEqual(tradesRoot(micro, r, null), false, String(r));
  }
  assert.strictEqual(tradesRoot(rules(['GC']), 'MGC', ['MGC']), true);
  assert.strictEqual(tradesRoot(rules(['SIL']), 'SI', ['SI']), true);
  assert.strictEqual(tradesRoot(rules(['GC']), 'SI', ['SI']), false);
  assert.strictEqual(tradesRoot(rules(['CL']), 'CL', ['CL']), true);
  assert.strictEqual(tradesRoot(rules(['CL']), 'MCL', ['MCL']), false);
  // Manual strategies: exactly what they list, whatever is selected.
  assert.strictEqual(tradesRoot({ signal: 'manual', instruments: ['MNQ'] }, 'NQ', ['NQ']), false);
  // Policy strategies: within what they list, the selected leg only; none selected, either leg listed.
  const policy = { signal: 'policy', instruments: ['MNQ', 'NQ', 'MES', 'ES'] };
  assert.strictEqual(tradesRoot({ signal: 'policy', instruments: ['MNQ'] }, 'NQ', ['NQ']), false);
  assert.strictEqual(rootRefusal(policy, 'NQ', ['MNQ']), 'trades MNQ (the selected contract), not NQ');
  assert.strictEqual(rootRefusal(policy, 'MNQ', ['NQ', 'MES']), 'trades NQ (the selected contract), not MNQ');
  assert.strictEqual(tradesRoot(policy, 'MNQ', ['MNQ']), true);
  assert.strictEqual(tradesRoot(policy, 'NQ', ['NQ']), true);
  assert.strictEqual(tradesRoot(policy, 'ES', ['MNQ']), true, 'no leg of its family selected: its list');
  for (const r of ['MNQ', 'NQ']) assert.strictEqual(tradesRoot(policy, r, null), true, `none selected: ${r}, its sizing's leg`);
  assert.strictEqual(tradesRoot({ signal: 'rules' }, 'MNQ', ['MNQ']), false, 'no instruments: nothing');
});

test('selection: FTH_SYMBOLS is one contract per index; anything else is an error the gate refuses on', () => {
  const { parseSelection, selectedSymbols } = require('../../scripts/lib/trading/contracts');
  assert.deepStrictEqual(parseSelection(undefined), { symbols: null });
  assert.deepStrictEqual(parseSelection('  '), { symbols: null });
  assert.deepStrictEqual(parseSelection('NQ, mes'), { symbols: ['NQ', 'MES'] });
  assert.match(parseSelection('MNQ,NQ').error, /selects two contracts of one index \(MNQ, NQ\)/);
  assert.match(parseSelection('MNQ,,MES').error, /not a comma-separated list/);
  assert.match(parseSelection('MNQ;rm -rf').error, /not a comma-separated list/);
  assert.throws(() => selectedSymbols({ FTH_SYMBOLS: 'ES,MES' }), /two contracts of one index/);
  assert.strictEqual(selectedSymbols({}), null);
  // An autonomous run's runner always sets it: unset there, the selection is lost (an error, never "its list").
  assert.throws(() => selectedSymbols({ FTH_AUTONOMOUS: '1' }), /FTH_SYMBOLS is not set in this autonomous run, .*a harness config installed before it was forwarded, which the user fixes by re-running node scripts\/install\.js --target <harness> \(e\.g\. codex\)$/);
  assert.deepStrictEqual(selectedSymbols({ FTH_AUTONOMOUS: '1', FTH_SYMBOLS: 'NQ' }), ['NQ']);
  assert.match(parseSelection('', { required: true }).error, /not set/);
  assert.deepStrictEqual(parseSelection('MNQLONGROOT'), { symbols: ['MNQLONGROOT'] }, 'any root the runner accepts');
});

test('order check: a rules strategy trades the selected leg only; an unreadable selection refuses every entry', () => {
  const s = { name: 'micro', valid: true, status: 'active', signal: 'rules', instruments: ['MNQ', 'MES'], sessions: [], compiledRules: { long: [{}], short: [{}] } };
  const now = new Date(Date.UTC(2026, 9, 7, 15, 0));
  const sel = symbols => ({ symbols });
  assert.strictEqual(checkStrategyForOrder([s], 'micro', 'NQ', now, 'buy', sel(['NQ'])), null);
  assert.strictEqual(checkStrategyForOrder([s], 'micro', 'MNQ', now, 'buy', sel(['MNQ'])), null);
  assert.strictEqual(checkStrategyForOrder([s], 'micro', 'NQ', now, 'buy', sel(['MNQ'])), 'setup:micro trades MNQ (the selected contract), not NQ.');
  assert.strictEqual(checkStrategyForOrder([s], 'micro', 'MNQ', now, 'buy', sel(['NQ'])), 'setup:micro trades NQ (the selected contract), not MNQ.');
  // Unknown selection: its list only (the default when none is passed).
  assert.strictEqual(checkStrategyForOrder([s], 'micro', 'MNQ', now, 'buy'), null);
  assert.match(checkStrategyForOrder([s], 'micro', 'NQ', now, 'buy'), /^setup:micro does not trade NQ \(instruments: MNQ, MES\); .*FTH_SYMBOLS=NQ\)\.$/);
  for (const r of ['RTY', 'M2K', 'GC', 'CL']) assert.match(checkStrategyForOrder([s], 'micro', r, now, 'buy', sel([r])), new RegExp(`^setup:micro does not trade ${r} \\(instruments: MNQ, MES\\)`), r);
  // The other checks still apply on the selected mini: status, sides.
  assert.match(checkStrategyForOrder([{ ...s, status: 'paper' }], 'micro', 'NQ', now, 'buy', sel(['NQ'])), /status "paper"/);
  assert.match(checkStrategyForOrder([{ ...s, compiledRules: { long: [{}], short: [] } }], 'micro', 'NQ', now, 'sell', sel(['NQ'])), /no short rules/);
  // An unreadable selection: refused, whatever the strategy.
  assert.match(checkStrategyForOrder([s], 'micro', 'MNQ', now, 'buy', { error: 'FTH_SYMBOLS selects two contracts of one index (MNQ, NQ): select one per index, e.g. MNQ or NQ' }), /^FTH_SYMBOLS selects two contracts .*No entries until it is fixed\.$/);
});

test('scan and recent signals follow the selected leg: NQ selected, NQ\'s bars get the micro-listed rules strategies and MNQ\'s none', () => {
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  // Bars where bos and ema_cross fired long (the parity bar, tests/e2e/mock-trading-e2e.test.js).
  const parity = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).filter(x => Date.parse(x.t) <= Date.parse('2026-04-28T04:09:00.000Z'));
  const { strategies } = loadStrategies(ROOT, {});
  const at = new Date(Date.parse(parity.at(-1).t) + 180000);
  const strip = rs => rs.map(r => JSON.stringify(r));
  const micro = scan(strategies, parity, { symbol: 'MNQ', now: at, selected: ['MNQ'] });
  assert.ok(micro.find(r => r.name === 'bos').candidate, 'bos fired');
  assert.deepStrictEqual(strip(scan(strategies, parity, { symbol: 'NQ', now: at, selected: ['NQ'] })), strip(micro));
  assert.deepStrictEqual(strip(scan(strategies, parity, { symbol: 'MNQ', now: at })), strip(micro), 'unknown selection: its list');
  // The leg not selected: only the policy strategies (which list both legs; their sizing picks one).
  const policyOnly = rs => rs.every(r => r.signal === 'policy');
  assert.ok(policyOnly(scan(strategies, parity, { symbol: 'NQ', now: at, selected: ['MNQ'] })));
  assert.ok(policyOnly(scan(strategies, parity, { symbol: 'MNQ', now: at, selected: ['NQ'] })));
  assert.ok(policyOnly(scan(strategies, parity, { symbol: 'NQ', now: at })), 'unknown selection: no micro-listed rules strategy on NQ');
  assert.deepStrictEqual(scan(strategies, parity, { symbol: 'GC', now: at, selected: ['GC'] }), [], 'no bundled strategy lists gold');
  const recentMicro = recentSignals(strategies, parity, { symbol: 'MNQ', count: 3, selected: ['MNQ'] });
  assert.ok(recentMicro.at(-1).fired.includes('bos long'), JSON.stringify(recentMicro));
  assert.deepStrictEqual(recentSignals(strategies, parity, { symbol: 'NQ', count: 3, selected: ['NQ'] }), recentMicro);
  for (const [symbol, selected] of [['NQ', ['MNQ']], ['MNQ', ['NQ']], ['NQ', null], ['GC', ['GC']]]) {
    assert.ok(recentSignals(strategies, parity, { symbol, count: 3, selected }).every(x => x.fired.length === 0), `${symbol} ${selected}`);
  }
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
  // The stop's expected slippage in sizing: at least the backtester's tick (more is stricter, less is refused).
  assert.deepStrictEqual(validateStrategy({ ...base, sizing: { stop_slippage_ticks: 2 } }, body, 'p'), validateStrategy(base, body, 'p'));
  assert.ok(validateStrategy({ ...base, sizing: { stop_slippage_ticks: 0 } }, body, 'p').some(e => /stop_slippage_ticks: at least 1/.test(e)));
  const rules = { name: 'r', description: 'x'.repeat(40), status: 'paper', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules: { long: ['close > 1'] }, risk: { stop: 'atr:1', min_rr: 2 } };
  for (const k of ['account', 'sizing', 'strategies', 'contracts']) {
    assert.ok(validateStrategy({ ...rules, [k]: k === 'sizing' ? { cushion_frac: 0.2 } : k === 'strategies' ? ['x'] : k === 'contracts' ? 'auto' : 'topstep_100k' }, body, 'r').some(e => e.startsWith(`${k}: only a policy strategy`)), k);
  }
  // priority (which policy goes first when lanes' policies collide in one cycle): a policy's own, 1 to 99, optional.
  for (const ok of [1, 2, 99]) assert.deepStrictEqual(validateStrategy({ ...base, priority: ok }, body, 'p'), [], String(ok));
  for (const bad of [0, 100, 1.5, -1, '1', null, true]) {
    assert.ok(validateStrategy({ ...base, priority: bad }, body, 'p').some(e => /^priority: a whole number 1 to 99/.test(e)), String(bad));
  }
  assert.ok(validateStrategy({ ...rules, priority: 1 }, body, 'r').some(e => e.startsWith('priority: only a policy strategy')));
  assert.ok(validateStrategy({ ...rules, signal: 'manual', rules: undefined, priority: 1 }, body, 'r').some(e => e.startsWith('priority: only a policy strategy')));
  // The trained policy is retired: `policy: { bundle }` is no key of any strategy, a policy strategy included.
  for (const x of [base, rules]) {
    assert.ok(validateStrategy({ ...x, policy: { bundle: 'b' } }, body, x.name).some(e => /^unknown key "policy"/.test(e)), x.name);
  }
  // Cross-checks against the other strategies, at load time.
  const dir = tmpDir();
  const write = (name, fm) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'STRATEGY.md'), `---\n${fm}\n---\n${body}\n`);
  };
  const head = n => [`name: ${n}`, `description: ${'x'.repeat(40)}`, 'status: paper', 'instruments: [MNQ, NQ]', 'signal: policy', 'account: topstep_100k',
    'risk:', '  stop: strategy', '  min_rr: 2'];
  write('p_ok', [...head('p_ok'), 'timeframe: 3m', 'strategies: [ema_cross, keltner]'].join('\n'));
  write('p_tf', [...head('p_tf'), 'timeframe: 3m', 'strategies: [ofi]'].join('\n'));
  write('p_none', [...head('p_none'), 'timeframe: 3m', 'strategies: [nope]'].join('\n'));
  write('p_es', [...head('p_es'), 'timeframe: 3m', 'strategies: [vwap_reclaim]'].join('\n').replace('instruments: [MNQ, NQ]', 'instruments: [MYM, YM]'));
  write('off_rules', ['name: off_rules', `description: ${'x'.repeat(40)}`, 'status: disabled', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules', 'rules:', '  long:', '    - close > 1', 'risk:', '  stop: atr:1', '  min_rr: 2'].join('\n'));
  write('p_off', [...head('p_off'), 'timeframe: 3m', 'strategies: [off_rules]'].join('\n'));
  // Each listed in its account's rulebook, which sizes and exits it (a policy states neither itself).
  const account = shippedPolicy().account;
  const root = rootWithPolicies(Object.fromEntries(['p_ok', 'p_tf', 'p_none', 'p_es', 'p_off'].map(n => [n, account])));
  const { strategies } = loadStrategies(root, { FTH_STRATEGIES_DIRS: dir });
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
  assert.strictEqual(byName.prop_portfolio.mtf, undefined);
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
  for (const k of ['emaCrossesLast30', 'adxFallingBars', 'keltnerWidthVsAvg20', 'supertrendFlipsLast20', 'range5Atr', 'session', 'volVsAvg60']) assert.ok(k in c, k);
  assert.ok(Number.isInteger(c.emaCrossesLast30) && c.session.high >= c.session.low);
  assert.ok(!('flow' in c), 'the harness computes no order flow: a broker puts it on its bars');
});
