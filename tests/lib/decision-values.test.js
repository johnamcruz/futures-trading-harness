'use strict';

// The broker field values at each decision (R35): what the strategies' rules read on the decision bar
// (rules.js valuesFor, session/record.js fieldValues), carried by the pass tap onto the decision line, the
// same for a live session and a replay step; and the fingerprint allowlist (broker/config.js fingerprintEnv)
// that puts the broker's bar-shaping settings, never a credential, in the session's hash and fingerprints.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { valuesFor, compileRules } = require('../../scripts/lib/trading/rules');
const { passTap, fieldValues, decisionRecord, brokerFingerprint } = require('../../scripts/lib/session/record');
const { createLiveSession, liveHash } = require('../../scripts/lib/session/live');
const { loadBrokers, activeBroker, fingerprintNames, fingerprintSettings, fingerprintSalt, valueDigest, DEFAULTS_FILE } = require('../../scripts/lib/broker/config');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { wireRunner, closedBarsOnly, runnerScan } = require('../../scripts/lib/runner-wiring');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');
const { readArchive, archiveFile } = require('../../scripts/lib/session/bars-archive');
const store = require('../../scripts/lib/replay/store');

const ROOT = path.resolve(__dirname, '..', '..');
const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0) => DAY + ((h + 4) * 60 + m) * 60000 + s * 1000;
const iso = ms => new Date(ms).toISOString();

test('valuesFor: each field a rule reads on the decision bar, by path; a look-back by path[n]; missing is null', () => {
  const bars = [{ t: 'a', x: { y: 1 } }, { t: 'b', x: { y: 2, z: true }, w: null }, { t: 'c', x: { y: 3, n: '4' } }];
  assert.deepStrictEqual(valuesFor('field("x.y") > 0', bars), { 'x.y': 3 });
  assert.deepStrictEqual(valuesFor('field("x.y")[1] > field(\'x.y\')[2]', bars), { 'x.y[1]': 2, 'x.y[2]': 1 });
  // As readField reads them: a boolean 1/0; a string, a null, a missing path or a look-back before the first bar null.
  assert.deepStrictEqual(valuesFor('field("x.z") >= 1', bars, 1), { 'x.z': 1 });
  assert.deepStrictEqual(valuesFor('field("x.n") > 0', bars), { 'x.n': null });
  assert.deepStrictEqual(valuesFor('field("w") > 0', bars, 1), { w: null });
  assert.deepStrictEqual(valuesFor('field("q.r") > 0', bars), { 'q.r': null });
  assert.deepStrictEqual(valuesFor('field("x.y")[5] > 0', bars), { 'x.y[5]': null });
  assert.deepStrictEqual(valuesFor('close > open', bars), {}, 'a rule that reads no field');
  // A group, raw or compiled (its text), and a whole strategy block.
  const raw = { any: ['field("x.y") > 0', { all: ['close > 1', 'field("x.z") > 0'] }] };
  assert.deepStrictEqual(valuesFor(raw, bars, 1), { 'x.y': 2, 'x.z': 1 });
  const { compiled } = compileRules({ long: [raw] });
  assert.deepStrictEqual(valuesFor(compiled.long[0], bars, 1), { 'x.y': 2, 'x.z': 1 });
  assert.deepStrictEqual(valuesFor([{ long: ['field("x.y") > 0'] }, { stop: 'field("x.y")[1]' }], bars), { 'x.y': 3, 'x.y[1]': 2 });
});

test('fieldValues: per strategy, only those that read a field; the tap carries them to the decision line', () => {
  const strategies = [
    { name: 'a', rules: { long: ['field("x.y") > 0'], short: ['field("x.y") < 0'] } },
    { name: 'b', rules: { long: ['close > open'] } },
    { name: 'c', rules: { long: ['close > open'] }, risk: { stop: 'field("x.s")' } },
  ];
  const bars = [{ t: 'a', x: { y: -1, s: 2 } }];
  assert.deepStrictEqual(fieldValues(strategies, bars), { a: { 'x.y': -1 }, c: { 'x.s': 2 } });
  assert.deepStrictEqual(fieldValues([], bars), {});
  const tap = passTap();
  tap.begin();
  tap.bar('MNQ', { bar: 'T1', stale: false, action: 'trade', values: { a: { 'x.y': null } } });
  tap.bar('MES', { bar: 'T2', stale: false, action: 'trade' }); // no values taken (a scan that failed)
  const p = tap.summary([]);
  assert.deepStrictEqual(p.values, [{ symbol: 'MNQ', contractId: null, barT: 'T1', strategies: { a: { 'x.y': null } } }], 'a null kept as null');
  const rec = decisionRecord({ t: 't', day: 'd', kind: 'trade', pass: { ...p, asked: 'trade' }, step: {}, cycles: [], refusals: [], trades: null, since: null });
  assert.deepStrictEqual(rec.values, p.values);
  assert.deepStrictEqual(decisionRecord({ pass: {} }).values, [], 'a line with no closed bar records none');
});

/** The 3m strategies of the repo that read a broker field, and bars carrying every path they read (k: a number per bar). */
function fieldWorld() {
  const strategies = loadStrategies(ROOT, {}).strategies.filter(s => s.valid && s.timeframe === '3m');
  const paths = [...new Set(Object.values(fieldValues(strategies, [{}])).flatMap(v => Object.keys(v)).map(p => p.replace(/\[\d+\]$/, '')))];
  assert.ok(paths.length > 0, 'a 3m strategy reads a broker field');
  const put = (bar, p, v) => {
    const segs = p.split('.');
    let o = bar;
    for (const s of segs.slice(0, -1)) o = o[s] = o[s] || {};
    o[segs[segs.length - 1]] = v;
    return bar;
  };
  const step = 180000;
  const bars = Array.from({ length: 40 }, (_, k) => paths.reduce((b, p, j) => put(b, p, Math.round((k - 20) * 10 + j) / 100), { t: iso(et(10, 0) - (39 - k) * step), o: 100, h: 102, l: 99, c: 101, v: 50 + k, extra: { kept: k } }));
  return { strategies, bars };
}

/** One pass of the wired runner at et(10, 3, 2), as autotrader.js wires it (the tap's bar sink). */
async function wiredPass({ home, env, bars, live, log: sessionLog = () => {}, passes = 1 }) {
  let t = et(10, 3, 2);
  const served = bars.slice();
  const now = () => new Date(t);
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });
  const broker = {
    async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; },
    async closedBars() { return JSON.parse(JSON.stringify(served)); },
    async accountState() { return { positions: [], orders: [] }; },
    async accountBalance() { return 50000; },
    async fillsSince() { return []; },
  };
  const tap = passTap();
  const log = tap.log(() => {});
  const runner = wireRunner({
    cfg, root: ROOT, home, env, client: live ? broker : closedBarsOnly(broker, now), dataDir: path.join(home, 'bars'), now,
    runCycle: async () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' }),
    loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log, event: tap.event(() => {}), onBarClosed: tap.bar,
  });
  if (live) {
    const session = createLiveSession({ cfg, root: ROOT, home, env, client: broker, now, log: sessionLog, tap, killSwitchFile: path.join(home, 'STOP') });
    await session.pass(runner);
    // Later passes: the next bar closed, 3 minutes on.
    for (let k = 1; k < passes; k += 1) {
      t += 180000;
      const last = served[served.length - 1];
      served.push({ ...last, t: iso(Date.parse(last.t) + 180000) });
      await session.pass(runner);
    }
    const day = tradingDayKey(new Date(t));
    const dir = path.join(home, 'sessions', day);
    return { line: store.readLines(path.join(dir, `${day}.jsonl`)).pop(), archive: readArchive(archiveFile(dir, day)) };
  }
  // A replay step (autotrader.js replayStep): the pass, its "REPLAY STEP" line, the driver's record of it.
  await runner.step();
  const { ran, events, errors, bars: b, values } = tap.summary(runner.symbols);
  const step = store.parseStep(`REPLAY STEP ${JSON.stringify({ asked: 'trade', at: iso(t), ran, events, errors, bars: b, values, state: runner.state })}\n`);
  const line = decisionRecord({ t: iso(t), day: tradingDayKey(new Date(t)), kind: 'trade', pass: step, step: { code: 0, timedOut: false }, cycles: [], refusals: [], trades: null, since: null });
  return { line, archive: readArchive(archiveFile(env.FTH_REPLAY_RECORD_DIR, tradingDayKey(new Date(t)))) };
}

test('parity: a live session and a replay step record the same values and archive the same bars for the same bars', { timeout: 120000 }, async () => {
  const { strategies, bars } = fieldWorld();
  const liveHome = tmpDir();
  const live = await wiredPass({ home: liveHome, env: { FTH_HOME: liveHome }, bars, live: true });
  const runHome = tmpDir();
  const runDir = path.join(runHome, 'replay', 'r1');
  const replay = await wiredPass({ home: runHome, env: { FTH_HOME: runHome, FTH_REPLAY_NOW: iso(et(10, 3, 2)), FTH_REPLAY_RECORD_DIR: runDir }, bars, live: false });
  assert.ok(live.line && replay.line);
  assert.deepStrictEqual(replay.line.values, live.line.values, 'the same values, live and replay');
  assert.deepStrictEqual(replay.line.bars, live.line.bars);
  // The values are what the strategies read on the decision bar (the last closed one), numbers, not nulls.
  const last = bars[bars.length - 1];
  // ... by exactly the strategies the runner's scan ran on MNQ (its lane, those that trade MNQ, none disabled).
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });
  const scanned = new Set(runnerScan(strategies, cfg, 'MNQ', bars, new Date(et(10, 3, 2))).map(r => r.name));
  assert.deepStrictEqual(live.line.values, [{ symbol: 'MNQ', contractId: 'MNQ', barT: last.t, strategies: fieldValues(strategies.filter(s => scanned.has(s.name)), bars) }]);
  assert.ok(Object.values(live.line.values[0].strategies).flatMap(Object.values).some(v => typeof v === 'number'));
  // Both archive the polled window with every field the broker sent, untouched.
  assert.deepStrictEqual(replay.archive, live.archive);
  assert.deepStrictEqual(live.archive.map(x => x.bar), bars);
  assert.ok(!fs.existsSync(path.join(runHome, 'sessions')), 'a replay step archives in its run\'s record dir only');
});

test('fingerprint allowlist: only the listed bar settings it reads, never a credential-like name; shipped lists are clamped', () => {
  const CREDS = ['X_API_KEY', 'X_SECRET', 'X_PASSWORD', 'X_DB_PWD', 'X_PIN', 'X_JWT', 'X_DSN', 'X_FEED_URL', 'X_FEED_URI', 'X_SESSION', 'X_BEARER', 'X_LOGIN', 'X_TOKEN', 'X_USERNAME', 'X_AUTH', 'X_COOKIE', 'X_CERT'];
  const b = { name: 'x', env: ['X_BARS_A', 'X_BARS_B', ...CREDS], fingerprintEnv: ['X_BARS_A', 'X_BARS_B', 'X_NOT_READ', 'bad name', ...CREDS] };
  assert.deepStrictEqual(fingerprintNames(b), { names: ['X_BARS_A', 'X_BARS_B'], refused: [...CREDS, 'X_NOT_READ', 'bad name'].sort() }, 'credential-like, malformed, or not a variable it reads');
  const SALT = 'a'.repeat(64);
  const env = { X_BARS_A: 'true', X_BARS_B: '', X_NOT_READ: 'n-333', ...Object.fromEntries(CREDS.map((k, i) => [k, `cred-${i}-value`])) };
  const fp = fingerprintSettings(b, env, { salt: SALT });
  assert.deepStrictEqual(fp, { name: 'x', settings: { X_BARS_A: valueDigest('true', SALT), X_BARS_B: null }, refused: fingerprintNames(b).refused });
  assert.match(fp.settings.X_BARS_A, /^hmac-sha256:[0-9a-f]{16}$/, 'a keyed digest, never the value');
  assert.notStrictEqual(valueDigest('true', SALT), valueDigest('false', SALT));
  assert.notStrictEqual(valueDigest('true', SALT), valueDigest('true', 'b'.repeat(64)), 'another home\'s salt, another digest');
  const plain = require('crypto').createHash('sha256').update('true').digest('hex').slice(0, 16);
  assert.ok(!fp.settings.X_BARS_A.includes(plain), 'not the unkeyed hash a guess could be checked against');
  for (const secret of [...Object.values(env).filter(Boolean)]) assert.ok(!JSON.stringify(fp).includes(secret), secret);
  assert.deepStrictEqual(fingerprintSettings({ name: 'y' }, env).settings, {}, 'no list: nothing recorded (and no salt needed)');
  // The shipped brokers list only names that aren't credentials, each one of the variables they read.
  const shipped = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8')).brokers;
  for (const [name, s] of Object.entries(shipped)) {
    assert.ok(Array.isArray(s.fingerprintEnv) && s.fingerprintEnv.length > 0, name);
    assert.deepStrictEqual(fingerprintNames(s).refused, [], name);
  }
  // An override can't change a shipped broker's list (it would add a credential to what sessions record); its own broker's stays.
  const dir = tmpDir();
  const shippedName = Object.keys(shipped)[0];
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ brokers: { [shippedName]: { fingerprintEnv: ['SOME_API_KEY', 'OTHER'] }, mine: { command: ['m'], env: ['MINE_BARS'], fingerprintEnv: ['MINE_BARS'] } } }));
  const loaded = loadBrokers({ FTH_HOME: dir });
  assert.deepStrictEqual(loaded.brokers[shippedName].fingerprintEnv, shipped[shippedName].fingerprintEnv);
  assert.deepStrictEqual(activeBroker({ FTH_HOME: dir, FTH_BROKER: 'mine' }).fingerprintEnv, ['MINE_BARS']);
});

test('fingerprint salt: random per home, made once with mode 0600, then kept', () => {
  const a = tmpDir();
  const b = tmpDir();
  const s1 = fingerprintSalt({ FTH_HOME: a });
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.strictEqual(fingerprintSalt({ FTH_HOME: a }), s1, 'kept');
  assert.strictEqual(fs.statSync(path.join(a, 'fingerprint.salt')).mode & 0o777, 0o600);
  assert.notStrictEqual(fingerprintSalt({ FTH_HOME: b }), s1, 'each home its own');
  fs.writeFileSync(path.join(b, 'fingerprint.salt'), 'short');
  assert.throws(() => fingerprintSalt({ FTH_HOME: b }), /not a fingerprint salt/);
});

test('liveHash: changes with a bar-shaping setting, never with a credential or another variable', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'mine', brokers: { mine: { command: ['m'], env: ['M_API_KEY', 'M_BARS_A', 'M_LIMIT'], fingerprintEnv: ['M_BARS_A', 'M_API_KEY'] } } }));
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 });
  const env = { FTH_HOME: dir, M_API_KEY: 'k1', M_BARS_A: '3,5', M_LIMIT: '1' };
  const h = e => liveHash({ cfg, root: ROOT, env: e });
  assert.strictEqual(h(env), h({ ...env }), 'the same home and settings: the same version');
  assert.notStrictEqual(h(env), h({ ...env, M_BARS_A: '3' }), 'a bar setting is part of the version');
  assert.notStrictEqual(h(env), h({ ...env, M_BARS_A: '' }), 'unset too');
  assert.strictEqual(h(env), h({ ...env, M_API_KEY: 'k2' }), 'a credential never is, even listed');
  assert.strictEqual(h(env), h({ ...env, M_LIMIT: '2' }), 'nor a variable off the list');
});

test('live session: the manifest\'s fingerprints carry the broker\'s bar settings as keyed digests, never a value or a credential', { timeout: 120000 }, async () => {
  const home = tmpDir();
  // A URL with a user and password: refused by its name (M_FEED_URL), and, under a name that passes (M_BARS_SOURCE),
  // kept only as a keyed digest.
  const url = 'https://feed-user:hunter2pass@feed.example.com/bars';
  const SECRET = ['very', 'secret', 'key'].join('-'); // built, so the repository's secret scan sees no literal
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mine', brokers: { mine: { command: ['m'], journal: 'j.jsonl', env: ['M_API_KEY', 'M_BARS_A', 'M_FEED_URL', 'M_BARS_SOURCE'], fingerprintEnv: ['M_BARS_A', 'M_API_KEY', 'M_FEED_URL', 'M_BARS_SOURCE'] } } }));
  const { bars } = fieldWorld();
  await wiredPass({ home, env: { FTH_HOME: home, M_API_KEY: SECRET, M_BARS_A: '3,5', M_FEED_URL: url, M_BARS_SOURCE: url }, bars, live: true });
  const day = tradingDayKey(new Date(et(10, 3, 2)));
  const m = JSON.parse(fs.readFileSync(path.join(home, 'sessions', day, 'manifest.json'), 'utf8'));
  const salt = fingerprintSalt({ FTH_HOME: home });
  assert.deepStrictEqual(m.fingerprints.broker, { name: 'mine', settings: { M_BARS_A: valueDigest('3,5', salt), M_BARS_SOURCE: valueDigest(url, salt) }, refused: ['M_API_KEY', 'M_FEED_URL'] });
  // Nothing the session wrote holds a value: not the key, the URL or its password, nor the bar setting itself.
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const written = walk(home).filter(x => !x.endsWith('brokers.json') && !x.endsWith('fingerprint.salt'));
  assert.ok(written.some(f => f.endsWith('manifest.json')) && written.some(f => f.endsWith('.gz')));
  for (const f of written) {
    const text = f.endsWith('.gz') ? require('zlib').gunzipSync(fs.readFileSync(f)).toString('utf8') : fs.readFileSync(f, 'utf8');
    for (const secret of [SECRET, url, 'hunter2pass', 'feed-user', '"3,5"']) assert.ok(!text.includes(secret), `${path.relative(home, f)}: ${secret}`);
  }
});

test('order of work: each bar\'s trailing stops and leftover orders run before its values are taken and its bars archived', { timeout: 120000 }, async () => {
  const home = tmpDir();
  const t = et(10, 3, 2);
  const step = 180000;
  const order = [];
  const client = {
    async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; },
    async closedBars() { return [0, 1, 2].map(k => ({ t: iso(et(10, 0) - (2 - k) * step), o: 1, h: 2, l: 0, c: 1, v: 1 })); },
    async accountState() { order.push('risk'); return { positions: [], orders: [] }; },
    async accountBalance() { return 50000; },
  };
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });
  const runner = wireRunner({
    cfg, root: ROOT, home, env: { FTH_HOME: home }, client, dataDir: path.join(home, 'bars'), now: () => new Date(t),
    runCycle: async () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' }), loadState: () => null, saveState: () => {},
    killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {}, onBarClosed: () => order.push('record'),
  });
  await runner.step();
  assert.ok(order.includes('record') && order.includes('risk'), order.join(','));
  assert.ok(order.indexOf('risk') < order.indexOf('record'), `the risk work first: ${order.join(',')}`);
});

test('fingerprint salt: callers racing to make it all get the same one, never a failure', async () => {
  const { spawn } = require('child_process');
  const home = tmpDir();
  const script = `const c = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'broker', 'config.js'))}); process.stdout.write(c.fingerprintSalt({ FTH_HOME: ${JSON.stringify(home)} }));`;
  const one = () => new Promise(resolve => {
    const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
  const results = await Promise.all(Array.from({ length: 24 }, one));
  assert.deepStrictEqual(results.filter(r => r.code !== 0).map(r => r.err), [], 'no caller failed');
  assert.strictEqual(new Set(results.map(r => r.out)).size, 1, 'one salt');
  assert.strictEqual(results[0].out, fs.readFileSync(path.join(home, 'fingerprint.salt'), 'utf8'));
  assert.deepStrictEqual(fs.readdirSync(home), ['fingerprint.salt'], 'no temporary file left behind');
});

test('fingerprint salt: a crash mid-make leaves nothing a reader trusts; an empty or short salt is retried, then refused', () => {
  const home = tmpDir();
  // A crash while writing it aside: a partial temporary file, no salt. The next caller makes the salt.
  fs.writeFileSync(path.join(home, 'fingerprint.salt.999.abcd.tmp'), '12ab');
  const s = fingerprintSalt({ FTH_HOME: home });
  assert.match(s, /^[0-9a-f]{64}$/);
  // An empty salt (written by something else, not yet whole): read again briefly, then refused, never used.
  const bad = tmpDir();
  fs.writeFileSync(path.join(bad, 'fingerprint.salt'), '');
  assert.throws(() => fingerprintSalt({ FTH_HOME: bad }, { retries: 2 }), /not a fingerprint salt/);
  // One that becomes whole while being read again is taken.
  const late = tmpDir();
  fs.writeFileSync(path.join(late, 'fingerprint.salt'), '');
  const { spawn } = require('child_process');
  const writer = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(path.join(late, 'fingerprint.salt'))}, '${'c'.repeat(64)}'), 30)`]);
  return new Promise(resolve => writer.on('spawn', () => {
    assert.strictEqual(fingerprintSalt({ FTH_HOME: late }, { retries: 200 }), 'c'.repeat(64));
    writer.on('close', resolve);
  }));
});

test('live session: a salt that can\'t be read is logged loudly and recorded as fingerprintError, never a silent null', { timeout: 120000 }, async () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mine', brokers: { mine: { command: ['m'], journal: 'j.jsonl', env: ['M_BARS_A'], fingerprintEnv: ['M_BARS_A'] } } }));
  fs.writeFileSync(path.join(home, 'fingerprint.salt'), 'corrupt');
  const { bars } = fieldWorld();
  const said = [];
  const env = { FTH_HOME: home, M_BARS_A: '3,5' };
  const { line } = await wiredPass({ home, env, bars, live: true, log: (msg, level) => said.push([msg, level]), passes: 3 });
  const day = tradingDayKey(new Date(et(10, 3, 2)));
  assert.strictEqual(store.readLines(path.join(home, 'sessions', day, `${day}.jsonl`)).length, 3, 'three decisions');
  assert.ok(line);
  const m = JSON.parse(fs.readFileSync(path.join(home, 'sessions', day, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.fingerprints.broker, null);
  assert.match(m.fingerprints.fingerprintError, /broker mine: its bar settings can't be fingerprinted \(.*not a fingerprint salt/);
  assert.deepStrictEqual(said.filter(([msg]) => /fingerprintError/.test(msg)).map(([, level]) => level), ['error'], 'logged once, as an error');
  // Its version is no other's: not a good home's with the same settings, nor one with none configured.
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });
  const good = tmpDir();
  fs.copyFileSync(path.join(home, 'brokers.json'), path.join(good, 'brokers.json'));
  assert.notStrictEqual(liveHash({ cfg, root: ROOT, env }), liveHash({ cfg, root: ROOT, env: { ...env, FTH_HOME: good } }));
});

/** A strategies folder (FTH_STRATEGIES_DIRS) with rules strategies that read a broker field: name -> { status, instruments }. */
function fieldStrategies(specs) {
  const dir = tmpDir();
  const template = fs.readFileSync(path.join(ROOT, 'strategies', '_template', 'STRATEGY.md'), 'utf8');
  for (const [name, { status, instruments }] of Object.entries(specs)) {
    const text = template
      .replace(/^name: .*$/m, `name: ${name}`)
      .replace(/^status: .*$/m, `status: ${status}`)
      .replace(/^instruments: .*$/m, `instruments: [${instruments.join(', ')}]`)
      .replace(/^ {4}- close crosses_above highest\(20\)\[1\]$/m, `    - field("fv.${name}") > 0`);
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'STRATEGY.md'), text);
  }
  return dir;
}

/** One wired pass at et(10, 3, 2) over `symbol`'s bars: what onBarClosed heard, and the scan's results. */
async function scannedPass({ env, symbol = 'MNQ', lanes = null }) {
  const home = tmpDir();
  const step = 180000;
  const heard = [];
  const bars = Array.from({ length: 40 }, (_, k) => ({ t: iso(et(10, 0) - (39 - k) * step), o: 100, h: 102, l: 99, c: 101, v: 50, fv: { fv_on: 1, fv_off: 2, fv_cl: 3, fv_two: 4 } }));
  const client = {
    async activeContract(s) { return { id: s, tickSize: 0.01 }; },
    async closedBars() { return JSON.parse(JSON.stringify(bars)); },
    async accountState() { return { positions: [], orders: [] }; },
    async accountBalance() { return 50000; },
  };
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: [symbol], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York', ...(lanes ? { lanes } : {}) });
  const runner = wireRunner({
    cfg, root: ROOT, home, env: { FTH_HOME: home, ...env }, client, dataDir: path.join(home, 'bars'), now: () => new Date(et(10, 3, 2)),
    runCycle: async () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' }), loadState: () => null, saveState: () => {},
    killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {}, onBarClosed: (s, info) => heard.push([s, info]),
  });
  await runner.step();
  return heard;
}

test('values: exactly the strategies the scan ran - never a disabled one, one that doesn\'t trade the symbol, or one off the lane', { timeout: 120000 }, async () => {
  const env = { FTH_STRATEGIES_DIRS: fieldStrategies({ fv_on: { status: 'active', instruments: ['MNQ'] }, fv_off: { status: 'disabled', instruments: ['MNQ'] }, fv_cl: { status: 'active', instruments: ['CL'] }, fv_two: { status: 'active', instruments: ['MNQ'] } }) };
  const valuesOf = heard => heard.filter(([, info]) => info.values).map(([, info]) => info.values);
  // MNQ: fv_on is scanned; the disabled fv_off and CL's fv_cl never are, so their values are never recorded.
  let heard = await scannedPass({ env });
  const mnq = valuesOf(heard);
  assert.strictEqual(mnq.length, 1, JSON.stringify(heard).slice(0, 300));
  assert.deepStrictEqual([mnq[0].fv_on, mnq[0].fv_two], [{ 'fv.fv_on': 1 }, { 'fv.fv_two': 4 }]);
  assert.ok(!('fv_off' in mnq[0]) && !('fv_cl' in mnq[0]), Object.keys(mnq[0]).join(','));
  // The scanned set and the recorded set are one: every recorded strategy is one the scan ran on this bar.
  const { strategies } = loadStrategies(ROOT, { FTH_HOME: tmpDir(), ...env });
  const bars = Array.from({ length: 40 }, (_, k) => ({ t: iso(et(10, 0) - (39 - k) * 180000), o: 100, h: 102, l: 99, c: 101, v: 50, fv: { fv_on: 1, fv_off: 2, fv_cl: 3, fv_two: 4 } }));
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });
  const scanned = new Set(runnerScan(strategies, cfg, 'MNQ', bars, new Date(et(10, 3, 2))).map(r => r.name));
  assert.deepStrictEqual(Object.keys(mnq[0]).sort(), Object.keys(fieldValues(strategies.filter(s => scanned.has(s.name)), bars)).sort());
  // CL: only the strategy that trades it.
  heard = await scannedPass({ env, symbol: 'CL' });
  assert.deepStrictEqual(valuesOf(heard).map(v => Object.keys(v).sort()), [['fv_cl']]);
  // A lane listing a subset: only what its scan runs (the listed strategy, and any its policies keep), fewer than all.
  const lanes = [{ timeframe: 3, trigger: 'bar', strategies: ['fv_on'] }];
  heard = await scannedPass({ env, lanes });
  const laneCfg = validateConfig({ ...cfg, lanes });
  const laneScanned = new Set(runnerScan(strategies, laneCfg, 'MNQ', bars, new Date(et(10, 3, 2))).map(r => r.name));
  const laneKeys = Object.keys(valuesOf(heard)[0]).sort();
  assert.deepStrictEqual(laneKeys, Object.keys(fieldValues(strategies.filter(s => laneScanned.has(s.name)), bars)).sort());
  assert.ok(laneKeys.includes('fv_on') && !laneKeys.includes('fv_two'), `${laneKeys}: fv_two is off the lane`);
});

test('fingerprint salt: made whole aside, synced, then linked into place - never written where a reader can see it half done', () => {
  const home = tmpDir();
  const file = path.join(home, 'fingerprint.salt');
  const calls = [];
  const orig = { linkSync: fs.linkSync, fsyncSync: fs.fsyncSync, writeSync: fs.writeSync };
  fs.writeSync = (fd, ...rest) => { calls.push(['write', fs.existsSync(file)]); return orig.writeSync.call(fs, fd, ...rest); };
  fs.fsyncSync = fd => { calls.push(['fsync']); return orig.fsyncSync.call(fs, fd); };
  fs.linkSync = (from, to) => {
    // At the link: the salt isn't there yet, and its source is already whole.
    calls.push(['link', to === file, fs.existsSync(file), fs.readFileSync(from, 'utf8').length]);
    return orig.linkSync.call(fs, from, to);
  };
  let salt;
  try {
    salt = fingerprintSalt({ FTH_HOME: home });
  } finally {
    Object.assign(fs, orig);
  }
  assert.deepStrictEqual(calls, [['write', false], ['fsync'], ['link', true, false, 64]], 'written aside, synced, linked');
  assert.strictEqual(salt.length, 64);
  // A second caller finds it and makes nothing.
  const again = [];
  fs.linkSync = (...a) => { again.push(a); return orig.linkSync.call(fs, ...a); };
  try { assert.strictEqual(fingerprintSalt({ FTH_HOME: home }), salt); } finally { fs.linkSync = orig.linkSync; }
  assert.deepStrictEqual(again, []);
});

test('liveHash: a broker fingerprint that fails is part of the version, never the same as another failure or as none', () => {
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 });
  const brokers = JSON.stringify({ broker: 'mine', brokers: { mine: { command: ['m'], env: ['M_BARS_A'], fingerprintEnv: ['M_BARS_A'] } } });
  // Two homes whose salts fail differently (a short one; a folder where the file should be): two versions.
  const short = tmpDir();
  fs.writeFileSync(path.join(short, 'brokers.json'), brokers);
  fs.writeFileSync(path.join(short, 'fingerprint.salt'), 'short');
  const folder = tmpDir();
  fs.writeFileSync(path.join(folder, 'brokers.json'), brokers);
  fs.mkdirSync(path.join(folder, 'fingerprint.salt'));
  const h = home => liveHash({ cfg, root: ROOT, env: { FTH_HOME: home, M_BARS_A: '3,5' } });
  assert.notStrictEqual(h(short), h(folder), 'the failure is in the hash, not just a null');
  assert.strictEqual(h(short), h(short));
});

test('pass tap: a scan\'s values join the symbol\'s closed bar of the pass - one entry, never a second bar', () => {
  const tap = passTap();
  tap.begin();
  tap.bar('MNQ', { bar: 'T1', stale: false, action: 'trade' });
  tap.bar('MES', { bar: 'T1', stale: true, action: 'trade' });
  tap.bar('MNQ', { bar: 'T1', contractId: 'C1', values: { a: { 'x.y': 2 } } });
  const p = tap.summary([]);
  assert.deepStrictEqual(p.closed, [
    { symbol: 'MNQ', bar: 'T1', stale: false, action: 'trade', contractId: 'C1', values: { a: { 'x.y': 2 } } },
    { symbol: 'MES', bar: 'T1', stale: true, action: 'trade' },
  ], 'joined to MNQ\'s bar, its stale flag and action kept');
  assert.deepStrictEqual(p.values, [{ symbol: 'MNQ', contractId: 'C1', barT: 'T1', strategies: { a: { 'x.y': 2 } } }]);
});

test('fingerprint allowlist: a setting dropped as a credential is said by name (never its value), once a session', { timeout: 120000 }, async () => {
  const home = tmpDir();
  const SECRET = ['tok', 'en', '-', 'value'].join('');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mine', brokers: { mine: { command: ['m'], journal: 'j.jsonl', env: ['M_BARS_A', 'M_API_KEY', 'M_NOT_A_CRED'], fingerprintEnv: ['M_BARS_A', 'M_API_KEY', 'M_ELSEWHERE'] } } }));
  const env = { FTH_HOME: home, M_BARS_A: '3,5', M_API_KEY: SECRET };
  const fp = brokerFingerprint(env);
  assert.strictEqual(fp.warning, 'broker mine: fingerprintEnv M_API_KEY looks like a credential: never recorded', 'credential-like names only (not one merely missing from env)');
  assert.deepStrictEqual(fp.broker.refused, ['M_API_KEY', 'M_ELSEWHERE']);
  const said = [];
  await wiredPass({ home, env, bars: fieldWorld().bars, live: true, log: (msg, level) => said.push([msg, level]), passes: 2 });
  const warned = said.filter(([msg]) => /looks like a credential/.test(msg));
  assert.deepStrictEqual(warned, [['session record: broker mine: fingerprintEnv M_API_KEY looks like a credential: never recorded', undefined]]);
  assert.ok(!said.some(([msg]) => msg.includes(SECRET)));
  assert.strictEqual(brokerFingerprint({ FTH_HOME: tmpDir() }).warning, null, 'no broker: nothing to say');
});
