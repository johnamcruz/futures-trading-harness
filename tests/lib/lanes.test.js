'use strict';

// The runner's timeframe lanes (scripts/lib/lanes.js): the config's `lanes` parsed and checked, the legacy
// `timeframe` as exactly one lane, each lane's strategies and policies, and the refusals.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, rootWithPolicies } = require('../helpers');
const L =require('../../scripts/lib/lanes');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { runnerScan } = require('../../scripts/lib/runner-wiring');
const { loadStrategies, onTimeframe } = require('../../scripts/lib/trading/strategies');
const P = require('../../scripts/lib/preflight');
const G = require('../fixtures/golden-bars');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = { harness: 'custom', command: ['agent', '{prompt}'], symbols: ['MNQ'], account: '7', paper: true };
const invalid = raw => {
  try {
    validateConfig(raw);
  } catch (err) {
    return err.message;
  }
  return assert.fail(`accepted ${JSON.stringify(raw)}`);
};

// A registry: rules strategies on 3m and 1m, a manual one, a policy per timeframe, and an invalid one.
const rules = (name, timeframe, more = {}) => ({ name, valid: true, errors: [], status: 'active', signal: 'rules', instruments: ['MNQ'], timeframe, ...more });
const policy = (name, timeframe, strategies, more = {}) => ({ name, valid: true, errors: [], status: 'active', signal: 'policy', instruments: ['MNQ'], timeframe, strategies, account: 'p', ...more });
const REG = [
  rules('a3', '3m'), rules('b3', '3m'), rules('c3', '3m'), rules('m3', '3m', { signal: 'manual' }),
  rules('a1', '1m'), rules('b1', '1m'),
  policy('pol3', '3m', ['b3']), policy('pol1', '1m', ['a1']),
  rules('broken', '3m', { valid: false, errors: ['rules: bad'] }),
];
const names = list => list.map(s => s.name);

test('no lanes: the config\'s timeframe and trigger are exactly one lane, and the config gains no key', () => {
  const cfg = validateConfig({ ...BASE, timeframe: 1, trigger: 'signal' });
  assert.ok(!('lanes' in cfg), 'a legacy config is left as it was');
  assert.deepStrictEqual(L.lanesOf(cfg), [{ timeframe: 1, trigger: 'signal', strategies: null, policies: null }]);
  assert.deepStrictEqual(L.lanesOf(validateConfig(BASE)), [{ timeframe: 3, trigger: 'bar', strategies: null, policies: null }]);
  // A partial config (as tests and tools pass to runnerScan): trigger defaults to bar.
  assert.deepStrictEqual(L.lanesOf({ timeframe: 3 }), [{ timeframe: 3, trigger: 'bar', strategies: null, policies: null }]);
  assert.deepStrictEqual(L.parseLanes({ timeframe: 5, trigger: 'bar' }, {}), { lanes: [{ timeframe: 5, trigger: 'bar', strategies: null, policies: null }], errors: [] });
});

test('one lane equals the legacy config: the same config but the lanes key, and its timeframe drives the derived defaults', () => {
  for (const [tf, trigger] of [[3, 'bar'], [1, 'signal'], [5, 'bar']]) {
    const legacy = validateConfig({ ...BASE, timeframe: tf, trigger });
    const laned = validateConfig({ ...BASE, lanes: [{ timeframe: tf, trigger }] });
    assert.deepStrictEqual(laned.lanes, [{ timeframe: tf, trigger, strategies: null, policies: null }]);
    const { lanes: _l, ...rest } = laned;
    assert.deepStrictEqual(rest, legacy, `${tf}m ${trigger}`);
    assert.deepStrictEqual(L.lanesOf(laned), L.lanesOf(legacy));
  }
  // The lane's timeframe, not the default 3, sets bars, the cycle cap and the timeout; trigger defaults to bar.
  const one = validateConfig({ ...BASE, lanes: [{ timeframe: 1 }] });
  assert.deepStrictEqual([one.timeframe, one.trigger, one.cycleTimeoutMinutes], [1, 'bar', 3]);
  assert.strictEqual(one.bars, validateConfig({ ...BASE, timeframe: 1 }).bars);
  assert.strictEqual(one.maxCyclesPerDay, validateConfig({ ...BASE, timeframe: 1 }).maxCyclesPerDay);
  // A timeframe or trigger equal to the first lane's is allowed; one that disagrees is refused.
  assert.strictEqual(validateConfig({ ...BASE, timeframe: 3, trigger: 'bar', lanes: [{ timeframe: 3 }] }).timeframe, 3);
  assert.match(invalid({ ...BASE, timeframe: 5, lanes: [{ timeframe: 3 }] }), /timeframe: with lanes, the first lane's timeframe \(3\)/);
  assert.match(invalid({ ...BASE, trigger: 'signal', lanes: [{ timeframe: 3 }] }), /trigger: with lanes, the first lane's trigger \(bar\)/);
});

test('the scan is the same with one lane as with the legacy timeframe, on the shipped strategies and real bars', () => {
  const all = loadStrategies(ROOT, {}).strategies;
  for (const s of G.SERIES) {
    const bars = G.load(s).slice(0, 1300);
    const now = new Date(Date.parse(bars.at(-1).t) + s.minutes * 60000);
    const legacy = validateConfig({ ...BASE, symbols: [s.symbol], timeframe: s.minutes });
    const laned = validateConfig({ ...BASE, symbols: [s.symbol], lanes: [{ timeframe: s.minutes, trigger: 'bar' }] });
    const a = runnerScan(all, legacy, s.symbol, bars, now);
    assert.ok(a.length > 0, s.label);
    assert.deepStrictEqual(runnerScan(all, laned, s.symbol, bars, now), a, s.label);
    assert.deepStrictEqual(names(L.laneStrategies(all, L.lanesOf(legacy)[0])), names(onTimeframe(all, `${s.minutes}m`)), s.label);
  }
  // A lane's list narrows the runner's scan (no policy here keeps the others in).
  const s = G.SERIES[0];
  const bars = G.load(s).slice(0, 1300);
  const now = new Date(Date.parse(bars.at(-1).t) + 180000);
  const rulesOnly = all.filter(x => x.signal !== 'policy');
  const narrowed = validateConfig({ ...BASE, lanes: [{ timeframe: 3, strategies: ['cisd_ote', 'orb'] }] });
  assert.deepStrictEqual(runnerScan(rulesOnly, narrowed, s.symbol, bars, now).map(r => r.name).sort(), ['cisd_ote', 'orb']);
});

test('lanes are checked: timeframe 1 to 60 and once each, known keys, trigger bar or signal, name lists', () => {
  const lanes = ls => L.parseLanes({ timeframe: 3, trigger: 'bar' }, { lanes: ls });
  assert.match(lanes([]).errors[0], /lanes: a non-empty list/);
  assert.match(lanes('3m').errors[0], /lanes: a non-empty list/);
  assert.match(lanes([3]).errors.join('\n'), /lanes\[0\]: an object/);
  for (const tf of [0, 61, 1.5, '3', '3m', null, undefined]) assert.match(lanes([{ timeframe: tf }]).errors.join('\n'), /lanes\[0\]\.timeframe: minutes per bar, 1 to 60/, String(tf));
  assert.deepStrictEqual(lanes([{ timeframe: 60 }]).errors, []);
  assert.match(lanes([{ timeframe: 3, trigger: 'tick' }]).errors.join('\n'), /lanes\[0\]\.trigger: "bar" or "signal"/);
  assert.match(lanes([{ timeframe: 3, timefrme: 1 }]).errors.join('\n'), /lanes\[0\]: unknown key "timefrme"/);
  for (const bad of [[], 'a3', ['A3'], ['a3', 'a3'], [3]]) {
    assert.match(lanes([{ timeframe: 3, strategies: bad }]).errors.join('\n'), /lanes\[0\]\.strategies: a non-empty list/, JSON.stringify(bad));
    assert.match(lanes([{ timeframe: 3, policies: bad }]).errors.join('\n'), /lanes\[0\]\.policies: a non-empty list/, JSON.stringify(bad));
  }
  // A list that is not a list (a number, an object, null) is the clear refusal, never a crash.
  for (const bad of [5, { a: 1 }, null, true]) {
    for (const k of ['strategies', 'policies']) {
      assert.match(invalid({ ...BASE, lanes: [{ timeframe: 3, [k]: bad }] }), new RegExp(`lanes\\[0\\]\\.${k}: a non-empty list`), `${k} ${JSON.stringify(bad)}`);
    }
  }
  // Unique timeframes, and a name in one lane only.
  assert.match(lanes([{ timeframe: 3 }, { timeframe: 3 }]).errors.join('\n'), /timeframe 3 appears in more than one lane/);
  assert.match(lanes([{ timeframe: 3, strategies: ['a3'] }, { timeframe: 1, policies: ['a3'] }]).errors.join('\n'), /a3 is listed more than once/);
  assert.match(lanes([{ timeframe: 3, strategies: ['a3'], policies: ['a3'] }]).errors.join('\n'), /a3 is listed more than once/);
});

test('several lanes are accepted (the runner cycles them together); each is parsed and checked', () => {
  const two = [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }];
  const parsed = L.parseLanes({ timeframe: 3, trigger: 'bar' }, { lanes: two });
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.lanes.length, 2, 'both lanes are parsed and checked');
  assert.strictEqual(L.MULTI_LANE_REFUSAL, undefined, 'the step-2 refusal is gone');
  const cfg = validateConfig({ ...BASE, lanes: two });
  assert.deepStrictEqual(L.lanesOf(cfg).map(l => [l.timeframe, l.trigger]), [[3, 'bar'], [1, 'signal']]);
  assert.deepStrictEqual([cfg.timeframe, cfg.trigger], [3, 'bar'], 'the first lane is the runner\'s');
  // A signal lane beyond the first needs the account too.
  assert.match(invalid({ ...BASE, account: '', lanes: two }), /account: required with a lane on trigger "signal"/);
  // The first lane's signal trigger: the existing check.
  assert.match(invalid({ ...BASE, account: '', lanes: [{ timeframe: 3, trigger: 'signal' }] }), /account: required with trigger "signal"/);
  // Preflight passes the config and lists each lane.
  const pre = P.configChecks({ ...BASE, lanes: two });
  assert.ok(pre.cfg, JSON.stringify(pre.results));
  // Per-agent timeframes are read now: an analyst on 15m is a valid config (its role is checked at start).
  assert.strictEqual(validateConfig({ ...BASE, lanes: two, agents: { 'market-structure-analyst': { timeframe: '15m' } } }).agents['market-structure-analyst'].timeframe, '15m');
  assert.strictEqual(L.AGENT_TIMEFRAME_REFUSAL, undefined, 'the step-1 refusal is gone');
});

test('a lane\'s strategies: those on its timeframe, narrowed by its lists; a listed policy keeps the strategies it trades', () => {
  const lane = (more = {}) => ({ timeframe: 3, trigger: 'bar', strategies: null, policies: null, ...more });
  assert.deepStrictEqual(names(L.laneStrategies(REG, lane())), ['a3', 'b3', 'c3', 'm3', 'pol3', 'broken']);
  assert.deepStrictEqual(names(L.laneStrategies(REG, lane({ timeframe: 1 }))), ['a1', 'b1', 'pol1']);
  assert.deepStrictEqual(names(L.laneStrategies(REG, lane({ timeframe: 5 }))), []);
  // Listed strategies only, plus the lane's policies' own (b3: pol3 trades it).
  assert.deepStrictEqual(names(L.laneStrategies(REG, lane({ strategies: ['c3'] }))), ['b3', 'c3', 'pol3']);
  assert.deepStrictEqual(names(L.laneStrategies(REG, lane({ strategies: ['c3'], policies: ['pol3'] }))), ['b3', 'c3', 'pol3']);
  // Listed policies only; every other strategy of the timeframe still scans.
  assert.deepStrictEqual(names(L.laneStrategies(REG, lane({ policies: ['pol3'] }))), ['a3', 'b3', 'c3', 'm3', 'pol3', 'broken']);
  // A name off the lane's timeframe never enters it, listed or not.
  assert.deepStrictEqual(names(L.laneStrategies(REG, lane({ strategies: ['a1'], policies: ['pol1'] }))), []);
  assert.deepStrictEqual(names(L.lanePolicies(REG, lane())), ['pol3']);
  assert.deepStrictEqual(names(L.lanePolicies(REG, lane({ timeframe: 1 }))), ['pol1']);
  assert.deepStrictEqual(names(L.lanePolicies(REG, lane({ policies: ['pol1'] }))), []);
});

test('a strategy or policy belongs to the lane of its timeframe: every other listing is refused', () => {
  const lane = (more = {}) => ({ timeframe: 3, trigger: 'bar', strategies: null, policies: null, ...more });
  assert.deepStrictEqual(L.laneStrategyErrors([lane()], REG), []);
  assert.deepStrictEqual(L.laneStrategyErrors([lane({ strategies: ['a3', 'm3'], policies: ['pol3'] }), lane({ timeframe: 1, strategies: ['b1'], policies: ['pol1'] })], REG), []);
  const err = more => L.laneStrategyErrors([lane(more)], REG).join('\n');
  assert.match(err({ strategies: ['a1'] }), /lanes\[0\]\.strategies: a1 trades 1m bars, not the 3m lane's/);
  assert.match(err({ policies: ['pol1'] }), /lanes\[0\]\.policies: pol1 trades 1m bars, not the 3m lane's/);
  assert.match(err({ strategies: ['nope'] }), /no strategy named nope/);
  assert.match(err({ strategies: ['broken'] }), /broken is not valid \(rules: bad\)/);
  assert.match(err({ strategies: ['pol3'] }), /pol3 is a policy strategy \(list it under policies\)/);
  assert.match(err({ policies: ['a3'] }), /a3 is signal: rules, not a policy strategy/);
  assert.strictEqual(L.laneStrategyErrors([lane({ strategies: ['a1', 'nope'], policies: ['a3'] })], REG).length, 3, 'every refusal, not the first');
});

test('a trigger "signal" lane needs a mechanical strategy that is not disabled (as the runner checked before lanes)', () => {
  const lane = (more = {}) => ({ timeframe: 3, trigger: 'signal', strategies: null, policies: null, ...more });
  assert.deepStrictEqual(L.signalLaneErrors([lane()], REG), []);
  assert.deepStrictEqual(L.signalLaneErrors([lane({ trigger: 'bar', timeframe: 5 })], REG), [], 'a bar lane never');
  assert.match(L.signalLaneErrors([lane({ timeframe: 5 })], REG)[0], /trigger "signal" with timeframe 5: no active mechanical strategy uses 5m/);
  const off = REG.map(s => (s.timeframe === '1m' && s.signal !== 'manual' ? { ...s, status: 'disabled' } : s));
  assert.strictEqual(L.signalLaneErrors([lane({ timeframe: 1 })], off).length, 1, 'disabled ones do not count');
  const manualOnly = [rules('m', '3m', { signal: 'manual' })];
  assert.strictEqual(L.signalLaneErrors([lane()], manualOnly).length, 1, 'a manual one does not fire');
});

test('preflight reports each lane and fails a listing off its lane; prop profiles follow the lanes', () => {
  const cfg = validateConfig({ ...BASE, timeframe: 3 });
  const rows = P.laneChecks(cfg, REG);
  assert.deepStrictEqual(rows.map(x => [x.check, x.status]), [['lane 3m', 'ok']]);
  assert.match(rows[0].detail, /^3m bars, trigger bar; strategies: a3, b3, c3, m3; policies: pol3 \(from timeframe and trigger\)$/);
  const listed = validateConfig({ ...BASE, lanes: [{ timeframe: 3, strategies: ['c3'], policies: ['pol3'] }] });
  assert.match(P.laneChecks(listed, REG)[0].detail, /strategies: b3, c3 \(listed\); policies: pol3 \(listed\)$/);
  const off = validateConfig({ ...BASE, lanes: [{ timeframe: 3, policies: ['pol1'] }] });
  const bad = P.laneChecks(off, REG);
  assert.strictEqual(bad.at(-1).status, 'fail');
  assert.match(bad.at(-1).detail, /pol1 trades 1m bars, not the 3m lane's/);
  // Prop profiles: the lane's policies only (pol1 on 1m is not this 3m runner's).
  const accounts = [{ name: 'p', valid: true }];
  assert.deepStrictEqual(P.propProfiles(REG.filter(s => s.name === 'pol1'), accounts, cfg), []);
  assert.deepStrictEqual(P.propProfiles(REG, accounts, cfg).map(a => a.name), ['p']);
  assert.deepStrictEqual(P.propProfiles(REG, accounts, validateConfig({ ...BASE, lanes: [{ timeframe: 3, policies: ['pol3'] }] })).map(a => a.name), ['p']);
});

test('CLI start: a lane listing off its timeframe is refused before anything runs; one lane and several lanes start', () => {
  const dir = tmpDir();
  const env = { ...process.env, HOME: dir, FTH_HOME: path.join(dir, '.futures-trading-harness'), FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP') };
  delete env.FTH_REPLAY_NOW;
  const cli = path.join(ROOT, 'scripts', 'autotrader.js');
  const start = (raw, k) => {
    const config = path.join(dir, `auto-${k}.json`);
    fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'], ...raw }));
    return spawnSync(process.execPath, [cli, '--config', config, '--dry-run'], { encoding: 'utf8', env });
  };
  try {
    const multi = start({ account: '7', lanes: [{ timeframe: 3 }, { timeframe: 1, trigger: 'signal' }] }, 'multi');
    assert.strictEqual(multi.status, 0, multi.stderr);
    assert.match(multi.stdout, /next action now:/);
    const off = start({ lanes: [{ timeframe: 3, policies: ['prop_flow_1m'] }] }, 'off');
    assert.strictEqual(off.status, 1);
    assert.match(off.stderr, /lanes\[0\]\.policies: prop_flow_1m trades 1m bars, not the 3m lane's/);
    const one = start({ lanes: [{ timeframe: 3, trigger: 'bar', policies: ['prop_portfolio'] }] }, 'one');
    assert.strictEqual(one.status, 0, one.stderr);
    assert.match(one.stdout, /next action now:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Agent roles' own timeframes (an approved addition to the lanes design): declared, overridable, refused off the lane.
const HS = require('../../scripts/lib/harness-sync');
const opencode = require('../../scripts/lib/opencode');
const AGENTS = HS.loadAgents(ROOT);

test('timeframes: "3m", "15m", "1h", "1d" in minutes; anything else is none', () => {
  assert.deepStrictEqual(['1m', '3m', '15m', '1h', '4h', '1d'].map(L.tfMinutes), [1, 3, 15, 60, 240, 1440]);
  for (const bad of ['0m', '3', 3, '15M', '1w', '', null, undefined, '01m', ' 3m']) assert.strictEqual(L.tfMinutes(bad), null, String(bad));
});

test('agent timeframes: none declared is the lane\'s for every role; the config may set a role to the lane\'s own', () => {
  assert.ok(AGENTS.length >= 8 && AGENTS.every(a => a.timeframe === undefined), 'no shipped role declares one yet');
  const cfg = validateConfig({ ...BASE, timeframe: 3 });
  assert.ok(!('agents' in cfg), 'a config without overrides gains no key');
  assert.deepStrictEqual(L.agentTimeframes(cfg, AGENTS), AGENTS.map(a => ({ role: a.name, timeframe: '3m', from: 'lane' })));
  assert.deepStrictEqual(L.agentErrors(cfg, AGENTS), []);
  const same = validateConfig({ ...BASE, timeframe: 3, agents: { 'risk-manager': { timeframe: '3m' } } });
  assert.deepStrictEqual(L.agentTimeframes(same, AGENTS).find(t => t.role === 'risk-manager'), { role: 'risk-manager', timeframe: '3m', from: 'config' });
  assert.deepStrictEqual(L.agentErrors(same, AGENTS), []);
  // An agent file's own timeframe, overridden by the config.
  const declared = AGENTS.map(a => (a.name === 'trend-momentum-analyst' ? { ...a, timeframe: '3m' } : a));
  assert.strictEqual(L.agentTimeframes(cfg, declared).find(t => t.role === 'trend-momentum-analyst').from, 'agent');
  assert.strictEqual(L.agentTimeframes(same, declared).find(t => t.role === 'risk-manager').from, 'config');
});

test('agent timeframes: an analyst may read its own (a lane\'s, or whole first-lane bars dividing the hour); any other role off the first lane\'s is refused', () => {
  // validateConfig checks only the shape and the timeframe; the roles at start (agentErrors).
  assert.strictEqual(validateConfig({ ...BASE, timeframe: 3, agents: { 'market-structure-analyst': { timeframe: '15m' } } }).agents['market-structure-analyst'].timeframe, '15m');
  assert.strictEqual(validateConfig({ ...BASE, timeframe: 60, agents: { 'risk-manager': { timeframe: '1h' } } }).agents['risk-manager'].timeframe, '1h');
  for (const [agents, re] of [
    ['15m', /agents: a map of role/], [['x'], /agents: a map of role/],
    [{ 'risk-manager': '15m' }, /agents\.risk-manager: an object/],
    [{ 'risk-manager': { timeframe: '15' } }, /agents\.risk-manager\.timeframe: a timeframe such as/],
    [{ 'risk-manager': { tf: '3m' } }, /agents\.risk-manager: unknown key "tf"/],
    [{ 'Risk Manager': { timeframe: '3m' } }, /"Risk Manager" is not a role name/],
  ]) assert.match(invalid({ ...BASE, agents }), re, JSON.stringify(agents));
  const cfgWith = (agents, more = {}) => validateConfig({ ...BASE, timeframe: 3, ...more, agents });
  // Analysts: 15m, 30m and 1h are whole 3m bars dividing the hour; 1m only as a lane's.
  for (const tf of ['15m', '30m', '1h', '3m']) assert.deepStrictEqual(L.agentErrors(cfgWith({ 'trend-momentum-analyst': { timeframe: tf } }), AGENTS), [], tf);
  for (const tf of ['1m', '5m', '45m', '2h', '4h', '1d']) {
    assert.match(L.agentErrors(cfgWith({ 'trend-momentum-analyst': { timeframe: tf } }), AGENTS).join('\n'), /agents\.trend-momentum-analyst\.timeframe: an analyst's timeframe is a lane's \(3m\) or whole 3m bars that divide the hour/, tf);
  }
  const laned = { lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }, { timeframe: 5, trigger: 'bar' }] };
  for (const tf of ['1m', '5m', '15m', '1h']) assert.deepStrictEqual(L.agentErrors(cfgWith({ 'volume-liquidity-analyst': { timeframe: tf } }, laned), AGENTS), [], tf);
  // Every other role decides once per cycle on the cycle's bars: off the first lane's, refused (its own lane's 3m is fine).
  for (const role of ['risk-manager', 'trade-executor', 'news-calendar-analyst', 'trade-reviewer']) {
    assert.match(L.agentErrors(cfgWith({ [role]: { timeframe: '15m' } }), AGENTS).join('\n'), new RegExp(`agents\\.${role}\\.timeframe: 15m, not the first lane's 3m: only the analysts .* read their own timeframe; ${role} decides once per cycle`), role);
    assert.deepStrictEqual(L.agentErrors(cfgWith({ [role]: { timeframe: '3m' } }), AGENTS), [], role);
  }
  // A role that doesn't exist: refused at start (the roles are files); an agent file's own timeframe is checked too.
  const cfg = validateConfig({ ...BASE, agents: { nobody: { timeframe: '3m' } } });
  assert.match(L.agentErrors(cfg, AGENTS).join('\n'), /agents\.nobody: no such role/);
  const declared = AGENTS.map(a => (a.name === 'risk-manager' ? { ...a, timeframe: '15m' } : a));
  assert.match(L.agentErrors(validateConfig(BASE), declared).join('\n'), /agents\/risk-manager\.md timeframe: 15m, not the first lane's 3m/);
  const badDecl = AGENTS.map(a => (a.name === 'risk-manager' ? { ...a, timeframe: 15 } : a));
  assert.match(L.agentErrors(validateConfig(BASE), badDecl).join('\n'), /agents\/risk-manager\.md timeframe: a timeframe such as/);
  // The config's override wins over a declared one.
  const fixed = validateConfig({ ...BASE, agents: { 'risk-manager': { timeframe: '3m' } } });
  assert.deepStrictEqual(L.agentErrors(fixed, declared), []);
  assert.strictEqual(L.startErrors(cfg, REG, AGENTS).length, 1);
});

test('analystFrames: the analysts off the first lane\'s timeframe, each with its lane (or -1: built from the first lane\'s bars); none by default', () => {
  assert.deepStrictEqual(L.analystFrames(validateConfig(BASE), AGENTS), [], 'no shipped role declares one: every role reads the first lane\'s bars');
  const laned = { lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }] };
  const cfg = validateConfig({ ...BASE, ...laned, agents: { 'market-structure-analyst': { timeframe: '3m' }, 'trend-momentum-analyst': { timeframe: '15m' }, 'volume-liquidity-analyst': { timeframe: '1h' }, 'risk-manager': { timeframe: '3m' } } });
  assert.deepStrictEqual(L.analystFrames(cfg, AGENTS), [{ role: 'trend-momentum-analyst', minutes: 15, lane: -1 }, { role: 'volume-liquidity-analyst', minutes: 60, lane: -1 }]);
  const oneMin = validateConfig({ ...BASE, ...laned, agents: { 'market-structure-analyst': { timeframe: '1m' } } });
  assert.deepStrictEqual(L.analystFrames(oneMin, AGENTS), [{ role: 'market-structure-analyst', minutes: 1, lane: 1 }]);
  // An agent file's own timeframe counts; a refused one (not a buildable timeframe) is never a frame.
  const declared = AGENTS.map(a => (a.name === 'trend-momentum-analyst' ? { ...a, timeframe: '1h' } : a.name === 'volume-liquidity-analyst' ? { ...a, timeframe: '5m' } : a));
  assert.deepStrictEqual(L.analystFrames(validateConfig(BASE), declared), [{ role: 'trend-momentum-analyst', minutes: 60, lane: -1 }]);
  assert.deepStrictEqual(['1m', '15m', '30m', '60m'].map(t => L.frameError(L.tfMinutes(t), L.lanesOf(validateConfig(BASE)))), [L.frameError(1, [{ timeframe: 3 }]), null, null, null]);
});

test('preflight shows each role\'s effective timeframe and fails a role that can\'t read its own', () => {
  const ok = P.agentChecks(validateConfig({ ...BASE, agents: { 'risk-manager': { timeframe: '3m' }, 'trend-momentum-analyst': { timeframe: '1h' } } }), AGENTS);
  assert.deepStrictEqual(ok.map(x => [x.check, x.status]), [['agent timeframes', 'ok']]);
  assert.match(ok[0].detail, /market-structure-analyst 3m, .*risk-manager 3m \(config\)/);
  assert.match(ok[0].detail, /trend-momentum-analyst 1h \(config\)/);
  const declared = AGENTS.map(a => (a.name === 'risk-manager' ? { ...a, timeframe: '15m' } : a));
  const bad = P.agentChecks(validateConfig(BASE), declared);
  assert.strictEqual(bad[0].status, 'fail');
  assert.match(bad[0].detail, /only the analysts .* read their own timeframe/);
});

test('an agent\'s timeframe key changes no generated adapter (Codex, Qwen Code, opencode)', () => {
  for (const a of AGENTS) {
    const withTf = { ...a, timeframe: '15m' };
    assert.strictEqual(HS.codexAgentToml(withTf), HS.codexAgentToml(a), a.name);
    assert.strictEqual(HS.qwenAgentMd(withTf), HS.qwenAgentMd(a), a.name);
    const docs = { skillDocs: HS.agentSkills(ROOT, a) };
    assert.deepStrictEqual(opencode.agentConfig({ ...withTf, ...docs }), opencode.agentConfig({ ...a, ...docs }), a.name);
  }
});

test('a first lane that is not an object is refused with its reason, never a crash in the cross-checks', () => {
  assert.match(invalid({ ...BASE, timeframe: 3, lanes: [5] }), /lanes\[0\]: an object/);
  assert.match(invalid({ ...BASE, trigger: 'bar', lanes: [null] }), /lanes\[0\]: an object/);
  assert.match(invalid({ ...BASE, timeframe: 3, trigger: 'bar', lanes: ['3m', { timeframe: 3 }] }), /lanes\[0\]: an object/);
});

test('a lane whose policies list leaves out a policy with a running attempt is refused at start, naming it', () => {
  const reg = [...REG, policy('pol3b', '3m', ['c3'], { account: 'q' })];
  const cfg = more => validateConfig({ ...BASE, lanes: [{ timeframe: 3, policies: ['pol3'], ...more }] });
  const running = new Set(['q']);
  const att = a => running.has(a);
  const errs = L.omittedPolicyErrors(cfg(), reg, att);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /lanes\[0\]\.policies: leaves out pol3b, a policy on 3m with a running q attempt/);
  assert.ok(L.startErrors(cfg(), reg, AGENTS, att).includes(errs[0]), 'checked at start');
  // Not refused: no attempt running, listed, another timeframe's, disabled (paper only in a paper run), another index.
  assert.deepStrictEqual(L.omittedPolicyErrors(cfg(), reg, () => false), []);
  assert.deepStrictEqual(L.omittedPolicyErrors(cfg({ policies: ['pol3', 'pol3b'] }), reg, att), []);
  assert.deepStrictEqual(L.omittedPolicyErrors(validateConfig({ ...BASE, timeframe: 3 }), reg, att), [], 'no list: every policy is in the lane');
  assert.deepStrictEqual(L.omittedPolicyErrors(cfg(), reg.map(s => (s.name === 'pol3b' ? { ...s, status: 'disabled' } : s)), att), []);
  const paperPol = reg.map(s => (s.name === 'pol3b' ? { ...s, status: 'paper' } : s));
  assert.deepStrictEqual(L.omittedPolicyErrors(validateConfig({ ...BASE, paper: false, lanes: [{ timeframe: 3, policies: ['pol3'] }] }), paperPol, att), []);
  assert.strictEqual(L.omittedPolicyErrors(cfg(), paperPol, att).length, 1, 'a paper run takes a paper policy');
  assert.deepStrictEqual(L.omittedPolicyErrors(cfg(), reg.map(s => (s.name === 'pol3b' ? { ...s, instruments: ['MES'] } : s)), att), []);
  // Preflight fails it too, with the home's attempts.
  assert.ok(P.laneChecks(cfg(), reg, null).every(x => x.status === 'ok'), 'no home: no attempt read');
  const home = tmpDir();
  try {
    require('../../scripts/lib/trading/prop-state').startAttempt(home, { name: 'q' }, new Date('2026-10-07T14:00:00Z'));
    const rows = P.laneChecks(cfg(), reg, home);
    assert.strictEqual(rows.at(-1).status, 'fail');
    assert.match(rows.at(-1).detail, /leaves out pol3b, a policy on 3m with a running q attempt/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('start checks include the signal-lane check; prop profiles follow a lane\'s listed policies', () => {
  const sig = validateConfig({ ...BASE, lanes: [{ timeframe: 5, trigger: 'signal' }] });
  assert.match(L.startErrors(sig, REG, AGENTS).join('\n'), /trigger "signal" with timeframe 5/);
  const reg = [...REG, policy('pol3b', '3m', ['c3'], { account: 'q' })];
  const accounts = [{ name: 'p', valid: true }, { name: 'q', valid: true }];
  assert.deepStrictEqual(P.propProfiles(reg, accounts, validateConfig({ ...BASE, timeframe: 3 })).map(a => a.name), ['p', 'q']);
  assert.deepStrictEqual(P.propProfiles(reg, accounts, validateConfig({ ...BASE, lanes: [{ timeframe: 3, policies: ['pol3b'] }] })).map(a => a.name), ['q']);
});

test('start and preflight read the home\'s attempts: a lane leaving out a second policy with a running attempt is refused', async () => {
  const dir = tmpDir();
  try {
    // A second 3m policy (a copy of the shipped one, on the same account), from an extra strategies directory, listed
    // in its account's rulebook: a plugin root with the repo linked in but its accounts copied (rootWithPolicies),
    // run with its symlinks kept so the scripts see that root.
    const extra = path.join(dir, 'strategies', 'prop_extra');
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8').replace(/^name: prop_portfolio/m, 'name: prop_extra'));
    const home = path.join(dir, '.futures-trading-harness');
    const account = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').account;
    const root = rootWithPolicies({ prop_extra: account });
    for (const e of fs.readdirSync(ROOT)) if (!['accounts', 'strategies', '.git'].includes(e)) fs.symlinkSync(path.join(ROOT, e), path.join(root, e));
    require('../../scripts/lib/trading/prop-state').startAttempt(home, { name: account }, new Date('2026-10-07T14:00:00Z'));
    const env = { ...process.env, HOME: dir, FTH_HOME: home, FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP'), FTH_STRATEGIES_DIRS: path.join(dir, 'strategies') };
    delete env.FTH_REPLAY_NOW;
    const raw = { harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'], paper: true, lanes: [{ timeframe: 3, policies: ['prop_portfolio'] }] };
    const config = path.join(dir, 'auto.json');
    fs.writeFileSync(config, JSON.stringify(raw));
    const run = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(root, 'scripts', 'autotrader.js'), '--config', config, '--dry-run'], { encoding: 'utf8', env });
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /lanes\[0\]\.policies: leaves out prop_extra, a policy on 3m with a running .* attempt/);
    const report = await P.runPreflight({ raw, root, env, home, deps: { now: () => new Date('2026-10-07T14:00:00Z'), resolve: () => '/bin/agent', open: () => { throw new Error('no broker here'); } } });
    const row = report.results.find(x => x.check === 'lane strategies');
    assert.ok(row && row.status === 'fail', JSON.stringify(report.results));
    assert.match(row.detail, /leaves out prop_extra/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
