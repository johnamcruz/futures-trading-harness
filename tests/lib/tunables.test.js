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

// The pins live in the lib (scripts/lib/tunables.js PINS: the loader refuses a file past one); a change there is a
// review finding by default (CLAUDE.md).
const { PINS } = T;

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
  refused('runner', writeAt(clone(committed('runner')), 'gate.maxConsecutiveLosses', 0), /gate\.maxConsecutiveLosses: a whole number from 1 to Infinity, not 0/);
  refused('runner', writeAt(clone(committed('runner')), 'gate.noEntryWindows', 'x'), /gate\.noEntryWindows: a list/);
  refused('training', writeAt(clone(committed('training')), 'keepRule.primary', 'meanR'), /keepRule\.primary: one of passRate/);
  refused('training', writeAt(clone(committed('training')), 'exitTest.correctReadRate', 1.2), /exitTest\.correctReadRate: a number from 0 to 1, not 1\.2/);
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

test('tunables: the built-in values equal the shipped runner and analysis files (never looser), deep-frozen; only those two', () => {
  assert.deepStrictEqual(Object.keys(T.BUILT_IN).sort(), ['analysis', 'runner']);
  for (const n of ['runner', 'analysis']) {
    assert.deepStrictEqual(clone(T.BUILT_IN[n]), committed(n), `${n}: BUILT_IN is the committed file`);
    assert.deepStrictEqual(C.loosened(T.SPECS[n], PINS[n], T.BUILT_IN[n]), [], `${n}: BUILT_IN holds every pin`);
    const frozen = v => !v || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozen));
    assert.ok(frozen(T.BUILT_IN[n]), `${n}: deep-frozen`);
  }
  assert.ok(Object.isFrozen(PINS) && Object.isFrozen(PINS.runner) && Object.isFrozen(PINS.runner['gate.noEntryWindows']));
  // The kill graces and the gate slack are pinned exactly.
  for (const k of ['runner.killGraceMs', 'runner.exitKillGraceMs', 'session.gateSlackMs']) {
    assert.strictEqual(T.SPECS.runner.tightenOnly[k], 'exact', k);
    assert.strictEqual(PINS.runner[k], C.valueAt(committed('runner'), k), k);
  }
});

test('tunables: the loader refuses a value past its pin (the pin is enforced at load, not only in tests), with the shape problems, all at once', () => {
  const dir = tmp();
  const f = path.join(dir, 'runner.json');
  fs.writeFileSync(f, JSON.stringify(writeAt(writeAt(clone(committed('runner')), 'gate.maxConsecutiveLosses', 5), 'runner.killGraceMs', 9000)));
  assert.throws(() => T.load('runner', f), e => e instanceof C.CriticalConfigError
    && /gate\.maxConsecutiveLosses is 5, above its pinned 2; it may only go down/.test(e.message)
    && /runner\.killGraceMs is 9000, not its pinned 10000; it is pinned exactly/.test(e.message));
  // A shape problem and a loosened key in one file: both listed; a key the shape refused is said once.
  fs.writeFileSync(f, JSON.stringify(dropAt(writeAt(writeAt(clone(committed('runner')), 'gate.maxDailyLosses', 9), 'gate.lossCooldownMin', 'x'), 'alerts.staleMinutes')));
  let err;
  try { T.load('runner', f); } catch (e) { err = e; }
  assert.deepStrictEqual(err.refusals[0].problems, [
    'gate.lossCooldownMin: a whole number from 0 to Infinity, not "x"',
    'alerts.staleMinutes: missing (expected a number above 0)',
    'gate.maxDailyLosses is 9, above its pinned 3; it may only go down (tighten)',
  ]);
  // Tighter is fine.
  fs.writeFileSync(f, JSON.stringify(writeAt(clone(committed('runner')), 'gate.maxConsecutiveLosses', 1)));
  assert.strictEqual(T.load('runner', f).gate.maxConsecutiveLosses, 1);
});

// A plugin root of its own: a copy of scripts/ and config/ (to break a config file), the rest linked to the repository's.
let copied = null;
function copiedRoot() {
  if (!copied) {
    copied = tmp();
    fs.cpSync(path.join(REPO, 'scripts'), path.join(copied, 'scripts'), { recursive: true });
    for (const d of ['strategies', 'accounts', 'skills', 'agents', 'commands', 'rules', 'mcp-configs', 'package.json']) if (fs.existsSync(path.join(REPO, d))) fs.symlinkSync(path.join(REPO, d), path.join(copied, d));
  }
  fs.rmSync(path.join(copied, 'config'), { recursive: true, force: true });
  fs.cpSync(path.join(REPO, 'config'), path.join(copied, 'config'), { recursive: true });
  return copied;
}
const home = tmp();
const ENV = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, NODE_ENV: 'test' };
const node = (root, code) => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', cwd: root, env: ENV });
const lib = (root, mod) => JSON.stringify(path.join(root, 'scripts', 'lib', ...mod.split('/')));

test('tunables: a refused runner or analysis file stands in its built-in values (the exits\' modules load) and is a critical error naming every problem', () => {
  const root = copiedRoot();
  const probe = `const T = require(${lib(root, 'tunables')}); const c = T.critical();
    process.stdout.write(JSON.stringify({ critical: c && c.message, files: c && c.refusals.map(r => r.name), losses: T.runner().gate.maxConsecutiveLosses, atr: T.analysis().indicators.atrPeriod }));`;
  // The positive control: the committed files load, no critical error.
  let r = node(root, probe);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).critical, null);
  assert.strictEqual(r.stderr, '');
  // runner.json broken two ways and analysis.json missing: every problem listed, the built-ins stand in.
  fs.writeFileSync(path.join(root, 'config', 'runner.json'), JSON.stringify(writeAt(writeAt(clone(committed('runner')), 'gate.maxConsecutiveLosses', 'two'), 'gate.extra', 1)));
  fs.rmSync(path.join(root, 'config', 'analysis.json'));
  r = node(root, probe);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(out.files, ['runner', 'analysis']);
  assert.deepStrictEqual([out.losses, out.atr], [T.BUILT_IN.runner.gate.maxConsecutiveLosses, T.BUILT_IN.analysis.indicators.atrPeriod]);
  assert.match(out.critical, /^CRITICAL config error \(3 problems in 2 files\):/);
  assert.match(out.critical, /the runner config \(.*config[\\/]runner\.json\) is refused: gate\.maxConsecutiveLosses: a whole number from 1 to Infinity, not "two"; gate\.extra: not a known key/);
  assert.match(out.critical, /the analysis config \(.*config[\\/]analysis\.json\) is refused: it can't be read \(ENOENT\)/);
  assert.match(out.critical, /no run, replay, training run, preflight or new entry starts until it is fixed/);
  assert.match(out.critical, /Exits, protective stops \(\[protect\]\), close_position, partial_close_position, cancel_order and the runner's reconcile and end-of-day flatten keep working on the built-in values/);
  // Said on stderr, once per file.
  assert.strictEqual((r.stderr.match(/\[fth\] CRITICAL config error/g) || []).length, 2, r.stderr);
  // The modules the exits need load (the gate hook's, the gateway's, the runner's); the run's entry points refuse.
  for (const mod of ['trading/order-gate', 'trading/gate-timing', 'trading/config', 'trading/check-order', 'trading/account-gate', 'trading/mcp-gateway', 'trading/trade-lifecycle', 'runner', 'runner-wiring', 'trading/briefing']) {
    const m = node(root, `require(${lib(root, mod)})`);
    assert.strictEqual(m.status, 0, `${mod}: ${m.stderr.slice(0, 300)}`);
  }
  const usable = node(root, `require(${lib(root, 'tunables')}).assertUsable()`);
  assert.notStrictEqual(usable.status, 0);
  assert.match(usable.stderr, /CRITICAL config error \(3 problems in 2 files\)/);
  const fp = node(root, `require(${lib(root, 'tunables')}).fingerprints()`);
  assert.match(fp.stderr, /CRITICAL config error/, 'no fingerprint of a built-in value is recorded');
});

test('tunables: a refused training or replay file throws the critical error where it is read (no built-in), naming every refused file', () => {
  const root = copiedRoot();
  fs.writeFileSync(path.join(root, 'config', 'training.json'), JSON.stringify(writeAt(clone(committed('training')), 'keepRule.level', 0.8)));
  fs.writeFileSync(path.join(root, 'config', 'runner.json'), '{ "version": ');
  const r = node(root, `require(${lib(root, 'train/model-verifier')})`);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /CRITICAL config error \(2 problems in 2 files\)/);
  assert.match(r.stderr, /the training config .* is refused: keepRule\.level is 0\.8, under its pinned 0\.9/);
  assert.match(r.stderr, /the runner config .* is refused: not JSON/);
  // The gate's modules still load (they read no training value).
  assert.strictEqual(node(root, `require(${lib(root, 'trading/order-gate')}); require(${lib(root, 'runner')})`).status, 0);
});

test('tunables: a run, replay, training run, preflight or backtest refuses to start on a refused config file, with the critical error', () => {
  const root = copiedRoot();
  const cli = (name, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', name), ...args], { encoding: 'utf8', cwd: root, env: ENV });
  const CLIS = [['replay.js'], ['train-loop.js'], ['training-preflight.js'], ['preflight.js'], ['backtest.js'], ['autotrader.js', '--once', 'trade', '--config', 'none.json']];
  // The positive control: with the committed files each stops for its own reason (usage, a missing file), not the config.
  for (const [name, ...args] of CLIS) {
    const r = cli(name, ...args);
    assert.doesNotMatch(r.stderr + r.stdout, /CRITICAL config error/, name);
  }
  fs.writeFileSync(path.join(root, 'config', 'runner.json'), JSON.stringify(writeAt(clone(committed('runner')), 'gate.minConfluence', 0)));
  for (const [name, ...args] of CLIS) {
    const r = cli(name, ...args);
    assert.notStrictEqual(r.status, 0, name);
    assert.match(r.stderr, /CRITICAL config error.*\n?.*the runner config \(.*runner\.json\) is refused: gate\.minConfluence: a whole number from 1 to Infinity, not 0/, `${name}: ${r.stderr.slice(0, 300)}`);
  }
  // End of day is not refused (it flattens): it goes on to its own checks.
  assert.doesNotMatch(cli('autotrader.js', '--once', 'eod', '--config', 'none.json').stderr.replace(/\[fth\][^\n]*\n/g, ''), /CRITICAL config error/);
});

