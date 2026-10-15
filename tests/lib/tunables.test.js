'use strict';

// The tunables' config files (config/training.json, replay.json, runner.json, analysis.json): schemas, fail-closed
// loading, the tighten-only pins, the fingerprints runs and ledgers record, and a refused file refusing the gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../../scripts/lib/config-files');
const T = require('../../scripts/lib/tunables');

const REPO = path.resolve(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-tunables-'));
const committed = name => JSON.parse(fs.readFileSync(path.join(REPO, 'config', `${name}.json`), 'utf8'));
const clone = x => JSON.parse(JSON.stringify(x));
const writeAt = (obj, dotted, v) => {
  const ks = dotted.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks[ks.length - 1]] = v;
  return obj;
};
const dropAt = (obj, dotted) => {
  const ks = dotted.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k];
  delete o[ks[ks.length - 1]];
  return obj;
};

/**
 * The loosest value each tighten-only key has ever been committed at ('exact': the one value it may hold). A change
 * may only tighten a value here (and in the file), never loosen it; a key leaves the list only with the owner's yes.
 */
const PINS = {
  training: {
    'exitTest.avgWinnerR': 1.8, 'exitTest.expectancyR': 0.3, 'exitTest.expectancyLoAbove': 0, 'exitTest.correctReadRate': 0.8, 'exitTest.processAdherence': 0.8,
    'experienceIndex.minN': 20, 'experienceIndex.minDays': 10, 'experienceIndex.level': 0.9, 'experienceLookups.maxPerBar': 2, 'riskRecord.minN': 10,
    'keepRule.maxChallengerBlows': 0, 'keepRule.level': 0.9, 'keepRule.primary': 'passRate', 'keepRule.minBlocks': 2, 'keepRule.minOverlap': 0.5,
    'decisionRule.alpha': 0.05, 'decisionRule.minPairs': 20, 'decisionRule.minDiscordant': 6, 'decisionRule.minEffect': 0.1, 'decisionRule.harmTolerance': 0.02, 'decisionRule.maxExcluded': 0.1,
    'screen.gainAlpha': 0.1, 'screen.harmAlpha': 0.2, 'screen.minDiscordant': 4, 'screen.minPairs': 10, 'screen.minEffect': 0.1,
    'loop.limits.maxIterations.max': 100, 'loop.limits.maxModelCalls.max': 100000, 'loop.limits.maxWallMinutes.max': 10080,
    'proposal.maxEdits': 3, 'proposal.maxText': 2000, 'proposal.maxChanged': 3000, 'looks.maxArms': 3,
    'skillCaps.skillBytes': 3400, 'skillCaps.setupSkillBytes': 4000,
  },
  replay: {
    stages: {
      1: { name: 'learn to trade', defaults: { latency: true, libraryDisplay: false, riskRecordDisplay: false }, refused: { learning: false, latency: false, libraryDisplay: true, riskRecordDisplay: true, prop: 'set', accountStates: 'set' }, comparisonOnly: [] },
      2: { name: 'pass prop', defaults: { latency: true, libraryDisplay: false, riskRecordDisplay: false }, refused: { learning: false, latency: false, libraryDisplay: true }, comparisonOnly: ['riskRecordDisplay'] },
    },
  },
  runner: {
    'gate.pendingOrderTtlMs': 30000, 'gate.orderGraceMs': 120000, 'gate.callTimeoutMs': 15000, 'gate.laneTimeoutMs': 30000, 'gate.lookupExtraMs': 5000, 'gate.markerLookbackMs': 60000,
    'gate.planMaxAgeMin': 120, 'gate.maxConsecutiveLosses': 2, 'gate.lossCooldownMin': 30, 'gate.maxDailyLosses': 3, 'gate.maxEntriesPerDay': 6, 'gate.mtfMaxAgeMin': 15,
    'gate.signalMaxAgeBars': 3, 'gate.signalMaxAgeCeilingMin': 45, 'gate.futureToleranceMin': 1, 'gate.minConfluence': 1, 'gate.maxCorrelatedPositions': 1,
    'gate.noEntryWindows': ['09:30-09:35@America/New_York', '15:45-16:00@America/New_York'], 'gate.bracketToleranceTicks': 1, 'gate.bracketSpanToleranceTicks': 2,
    'gate.factsMinChecked': 2, 'gate.factsMaxItems': 20,
    'lifecycle.stopBufferTicks': 1, 'lifecycle.floorTicks': 8, 'lifecycle.floorAtr': 0.25, 'lifecycle.maxSize': 100,
    'account.snapshotMaxAgeMs': 600000, 'account.balanceToleranceUsd': 0.01, 'account.snapshotFutureToleranceMs': 60000,
    'clock.serverTimeToleranceMs': 300000, 'clock.wallStartMaxAgeMs': 86400000, 'clock.wallStartAheadMs': 5000,
    'cycle.maxConsecutiveErrors': 3, 'bars.staleAfterBars': 0.5, 'runner.closeSettleMs': 10000, 'runner.fillGraceMs': 30000, 'runner.minManagedRiskTicks': 4,
    'monteCarlo.max': 20000,
  },
  analysis: {},
};

test('tunables: every committed config file loads under its schema, frozen, versioned', () => {
  assert.deepStrictEqual([...T.NAMES], ['training', 'replay', 'runner', 'analysis']);
  for (const n of T.NAMES) {
    const v = T[n]();
    assert.ok(Object.isFrozen(v), n);
    assert.strictEqual(typeof v.version, 'string', n);
    assert.deepStrictEqual(T.SPECS[n].validate(committed(n)), [], n);
    assert.strictEqual(T[n](), v, `${n}: loaded once per process`);
    assert.deepStrictEqual(T.load(n, path.join(REPO, 'config', `${n}.json`)), committed(n));
  }
  assert.throws(() => T.load('nope'), /no config "nope" \(training, replay, runner, analysis\)/);
});

test('tunables: the tighten-only keys hold their pins (never loosened); a looser value of each is refused', () => {
  for (const n of T.NAMES) {
    assert.deepStrictEqual(Object.keys(T.SPECS[n].tightenOnly).sort(), Object.keys(PINS[n]).sort(), `${n}: every tighten-only key is pinned`);
    assert.deepStrictEqual(C.loosened(T.SPECS[n], PINS[n], committed(n)), [], n);
    for (const [k, dir] of Object.entries(T.SPECS[n].tightenOnly)) {
      const v = C.valueAt(committed(n), k);
      const looser = dir === 'down' ? v + 1 : dir === 'up' ? v - 0.5 : dir === 'exact' ? (typeof v === 'number' ? v + 1 : 'changed') : false;
      assert.strictEqual(C.loosened(T.SPECS[n], PINS[n], writeAt(clone(committed(n)), k, looser)).length, 1, `${n}.${k} ${dir}: ${JSON.stringify(looser)} is caught`);
      if (dir === 'down' || dir === 'up') {
        const tighter = dir === 'down' ? v / 2 : v + 1;
        assert.deepStrictEqual(C.loosened(T.SPECS[n], PINS[n], writeAt(clone(committed(n)), k, tighter)), [], `${n}.${k}: tighter is fine`);
      }
    }
  }
  // 'exact' holds lists and objects whole.
  assert.strictEqual(C.loosened(T.SPECS.runner, PINS.runner, writeAt(clone(committed('runner')), 'gate.noEntryWindows', ['09:30-09:35@America/New_York'])).length, 1);
  assert.strictEqual(C.loosened(T.SPECS.replay, PINS.replay, writeAt(clone(committed('replay')), 'stages.1.refused.latency', true)).length, 1);
});

test('tunables: a missing, unreadable, non-JSON, incomplete, unknown-keyed or mistyped file is refused (never a default)', () => {
  const dir = tmp();
  const f = path.join(dir, 'x.json');
  const refused = (name, value, re) => {
    fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
    assert.throws(() => T.load(name, f), re);
  };
  assert.throws(() => T.load('runner', path.join(dir, 'none.json')), /the runner config .* is refused: it can't be read \(ENOENT\)/);
  refused('runner', '{ "version": ', /refused: not JSON/);
  refused('runner', [], /refused: not a JSON object/);
  refused('runner', dropAt(clone(committed('runner')), 'gate.maxConsecutiveLosses'), /gate\.maxConsecutiveLosses: missing/);
  refused('runner', writeAt(clone(committed('runner')), 'gate.extra', 1), /gate\.extra: not a known key/);
  refused('runner', writeAt(clone(committed('runner')), 'gate.maxConsecutiveLosses', '2'), /gate\.maxConsecutiveLosses: a whole number/);
  refused('runner', writeAt(clone(committed('runner')), 'gate.maxConsecutiveLosses', 0), /gate\.maxConsecutiveLosses: from 1 to Infinity/);
  refused('runner', writeAt(clone(committed('runner')), 'gate.noEntryWindows', 'x'), /gate\.noEntryWindows: a list/);
  refused('training', writeAt(clone(committed('training')), 'keepRule.primary', 'meanR'), /keepRule\.primary: one of passRate/);
  refused('training', writeAt(clone(committed('training')), 'exitTest.correctReadRate', 1.2), /exitTest\.correctReadRate: from 0 to 1/);
  refused('replay', writeAt(clone(committed('replay')), 'stages.1.refused.prop', 'maybe'), /stages\.1\.refused\.prop: true, false or 'set'/);
  refused('replay', writeAt(clone(committed('replay')), 'labels.stopAtrRange', [1]), /labels\.stopAtrRange: a list of 2 to 2/);
  refused('analysis', writeAt(clone(committed('analysis')), 'regime.highVol', null), /regime\.highVol: a number/);
  refused('analysis', dropAt(clone(committed('analysis')), 'cisd'), /cisd: missing/);
  refused('analysis', writeAt(clone(committed('analysis')), 'fvg.frames', [5, 'x']), /fvg\.frames\[1\]: a whole number/);
});

test('tunables: fingerprints name each file\'s version and canonical hash (what runs and ledger entries record)', () => {
  const fp = T.fingerprints();
  assert.deepStrictEqual(Object.keys(fp), [...T.NAMES]);
  for (const n of T.NAMES) assert.deepStrictEqual(fp[n], { version: committed(n).version, hash: C.hashOf(committed(n)) });
});

test('tunables: a refused config file refuses the gate, the runner and the reads that need it (fail closed, no default)', () => {
  const root = tmp();
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'config'), path.join(root, 'config'), { recursive: true });
  for (const d of ['strategies', 'accounts', 'skills', 'agents']) fs.symlinkSync(path.join(REPO, d), path.join(root, d));
  const load = mod => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, 'scripts', 'lib', ...mod.split('/')))})`], { encoding: 'utf8' });
  for (const mod of ['trading/order-gate', 'trading/gate-timing', 'runner', 'trading/briefing']) assert.strictEqual(load(mod).status, 0, `${mod} loads with the committed files`);
  // The runner config missing: the gate's modules don't load.
  fs.renameSync(path.join(root, 'config', 'runner.json'), path.join(root, 'config', 'runner.away'));
  for (const mod of ['trading/order-gate', 'trading/gate-timing', 'trading/config', 'runner']) {
    const r = load(mod);
    assert.notStrictEqual(r.status, 0, mod);
    assert.match(r.stderr, /the runner config \(.*runner\.json\) is refused: it can't be read \(ENOENT\)/, mod);
  }
  // Malformed: a gate value that isn't a number, or a key the schema doesn't know.
  const good = committed('runner');
  fs.writeFileSync(path.join(root, 'config', 'runner.json'), JSON.stringify(writeAt(clone(good), 'gate.maxConsecutiveLosses', 'two')));
  assert.match(load('trading/order-gate').stderr, /gate\.maxConsecutiveLosses: a whole number/);
  fs.writeFileSync(path.join(root, 'config', 'runner.json'), JSON.stringify(writeAt(clone(good), 'gate.maxLosses', 9)));
  assert.match(load('trading/order-gate').stderr, /gate\.maxLosses: not a known key/);
  // The reads refuse a missing analysis file.
  fs.writeFileSync(path.join(root, 'config', 'runner.json'), JSON.stringify(good));
  fs.rmSync(path.join(root, 'config', 'analysis.json'));
  assert.match(load('trading/briefing').stderr, /the analysis config .* is refused/);
});
