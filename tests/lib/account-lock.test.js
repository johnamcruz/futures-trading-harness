'use strict';

// One runner per broker account across every harness home (scripts/lib/account-lock.js): a shared lock
// directory, keyed by broker and normalized account id, taken atomically, stale-safe, released on exit.
// Every test uses a temp lock directory (FTH_LOCK_DIR); none touches the user's own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('../helpers');
const L = require('../../scripts/lib/account-lock');

const MODULE = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'account-lock.js');
const LIVE = { name: 'live', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_API_URL'] };
const SERVER = L.serverIdentities({ broker: LIVE })[0]; // 'name:live': no command, no apiUrl
const AUTOTRADER_ARG = '/x/scripts/autotrader.js'; // a child that reads as an autotrader to the liveness check

/** A child process that runs `code` (with L, the module, and the lock env) and reads as an autotrader. */
function child(code, env) {
  const p = spawn(process.execPath, ['-e', `const L = require(${JSON.stringify(MODULE)});\n${code}`, AUTOTRADER_ARG], { env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const io = { out: '' };
  p.stdout.on('data', c => { io.out += c; });
  p.stderr.on('data', c => { io.out += c; });
  return { p, io, done: new Promise(r => p.on('close', code2 => r(code2))) };
}

const waitFor = (what, ms, cond) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => (cond() ? resolve() : Date.now() - started > ms ? reject(new Error(`${what}: not within ${ms} ms`)) : setTimeout(tick, 20));
  tick();
});

const deadPid = async () => {
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(r => gone.on('exit', r));
  return gone.pid;
};

test('lockDir: shared by every harness home (neither FTH_HOME nor HOME moves it: the OS account\'s home); FTH_LOCK_DIR only for tests', () => {
  const home = '/home/u';
  assert.strictEqual(L.lockDir({}, home), path.join(home, '.futures-trading-harness', 'locks'));
  assert.strictEqual(L.lockDir({ FTH_HOME: '/elsewhere', HOME: '/other' }, home), path.join(home, '.futures-trading-harness', 'locks'), 'not per home');
  const saved = process.env.HOME;
  try {
    process.env.HOME = '/somewhere/else';
    assert.strictEqual(L.lockDir({}), path.join(os.userInfo().homedir, '.futures-trading-harness', 'locks'), 'HOME does not move it');
  } finally {
    process.env.HOME = saved;
  }
  assert.strictEqual(L.lockDir({ FTH_LOCK_DIR: '/tmp/l' }, home), path.resolve('/tmp/l'));
  assert.strictEqual(L.lockDir({ FTH_LOCK_DIR: '~/l' }, home), path.join(home, 'l'));
  assert.strictEqual(L.lockDir({ FTH_LOCK_DIR: '  ' }, home), path.join(home, '.futures-trading-harness', 'locks'));
  // An override outside tests: refused (runners would not see each other), never just warned about.
  assert.strictEqual(L.lockDirProblem({}), null);
  assert.strictEqual(L.lockDirProblem({ FTH_LOCK_DIR: '/x', FTH_TEST_LOCKS: '1' }), null);
  for (const env of [{ FTH_LOCK_DIR: '/x' }, { FTH_LOCK_DIR: '/x', FTH_TEST_LOCKS: 'true' }]) {
    assert.match(L.lockDirProblem(env), /FTH_LOCK_DIR is set \(\/x\).*for tests only/);
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /FTH_LOCK_DIR is set/);
    assert.throws(() => L.checkAccountLock({ env, broker: LIVE, accountId: '7' }), /FTH_LOCK_DIR is set/);
  }
});

test('lockFileFor: one file per broker server and account id, normalized as the gate compares them', () => {
  const env = { FTH_LOCK_DIR: '/l' };
  const f = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  assert.match(f, /^\/l\/account-[0-9a-f]{16}-7\.lock$/);
  for (const id of [7, '007', ' 7 ']) assert.strictEqual(L.lockFileFor({ env, server: SERVER, accountId: id }), f, String(id));
  assert.notStrictEqual(L.lockFileFor({ env, server: SERVER, accountId: '8' }), f);
  assert.notStrictEqual(L.lockFileFor({ env, server: 'name:other', accountId: '7' }), f);
  assert.strictEqual(path.dirname(L.lockFileFor({ env, server: 'cmd:../../x/y', accountId: '7' })), '/l', 'a server never leaves the directory');
  for (const bad of ['', 'abc', null, undefined, '7a', 1.5]) assert.strictEqual(L.lockFileFor({ env, server: SERVER, accountId: bad }), null, String(bad));
});

test('serverIdentities: the server, not its broker name - its resolved command (real paths, any node), else the name; plus its apiUrl once it answers', () => {
  const dir = tmpDir();
  const entry = path.join(dir, 'server.js');
  fs.writeFileSync(entry, '');
  const link = path.join(dir, 'alias.js');
  fs.symlinkSync(entry, link);
  const [a] = L.serverIdentities({ broker: { name: 'live', command: [process.execPath, entry] } });
  assert.strictEqual(a, `cmd:${fs.realpathSync(entry)}`);
  for (const b of [{ name: 'live2', command: [process.execPath, entry] }, { name: 'x', command: ['node', link] }, { name: 'y', command: ['/opt/other/bin/node', path.join(dir, '.', 'server.js')] }]) {
    assert.deepStrictEqual(L.serverIdentities({ broker: b }), [a], JSON.stringify(b.command));
  }
  assert.notStrictEqual(L.serverIdentities({ broker: { name: 'live', command: [process.execPath, entry, '--sim'] } })[0], a, 'other arguments, another server');
  assert.deepStrictEqual(L.serverIdentities({ broker: { name: 'live', command: ['a'] }, config: { apiUrl: 'https://API.example.test/' } }), ['cmd:a', 'api:https://api.example.test']);
  assert.strictEqual(L.serverIdentities({ broker: { name: 'other', command: ['b'] }, config: { apiUrl: 'https://api.example.test' } })[1], 'api:https://api.example.test', 'two installs on one API: one key');
  assert.deepStrictEqual(L.serverIdentities({ broker: { name: 'live', command: [process.execPath, entry] }, config: { apiUrl: '  ' } }), [a], 'a blank apiUrl: the command only');
  assert.deepStrictEqual(L.serverIdentities({ broker: { name: 'live' } }), ['name:live']);
  assert.deepStrictEqual(L.serverIdentities({}), ['name:broker']);
});

test('acquireAccountLocks: every key or none; a run on one API through another install is refused; held() reads the token', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const a = L.acquireAccountLocks({ env, broker: LIVE, servers: ['cmd:/a/server.js', 'api:https://api.example.test'], accountId: '7', home: '/homes/a' });
  assert.strictEqual(a.files.length, 2);
  assert.strictEqual(a.held(), true);
  assert.throws(() => L.acquireAccountLocks({ env, broker: { name: 'copy' }, servers: ['cmd:/b/server.js', 'api:https://api.example.test'], accountId: '7' }), /account 7 on broker "copy" is already traded by another runner \(pid \d+ on host .*, harness home \/homes\/a/);
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR).sort(), a.files.map(f => path.basename(f)).sort(), 'the refused run released the key it had taken');
  fs.writeFileSync(a.files[1], JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone else' }));
  assert.strictEqual(a.held(), false, 'a lock no longer ours');
  a.release();
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), [path.basename(a.files[1])], 'only our own lock removed');
  assert.strictEqual(a.held(), false);
});

test('lockExemption: paper and a confirmed replay (broker config and server both say replay) are exempt; anything else is live', () => {
  assert.strictEqual(L.lockExemption({ paper: true, broker: LIVE, config: null }), 'paper');
  assert.strictEqual(L.lockExemption({ paper: false, broker: { ...LIVE, replay: true }, config: { replay: true } }), 'replay');
  assert.strictEqual(L.lockExemption({ paper: false, broker: { ...LIVE, replay: true }, config: { replay: false } }), null, 'its server does not confirm');
  assert.strictEqual(L.lockExemption({ paper: false, broker: LIVE, config: { replay: true } }), null, 'a live broker whose server says replay');
  assert.strictEqual(L.lockExemption({ paper: false, broker: { ...LIVE, replay: true }, config: null }), null);
  assert.strictEqual(L.lockExemption({ paper: 'yes', broker: LIVE, config: {} }), null);
});

test('acquire: the record names pid, host, home and start; a second home on the same account is refused; another account is not', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const a = L.acquireAccountLock({ env, broker: LIVE, accountId: '7', home: '/homes/a', now: () => new Date('2026-10-13T13:00:00Z') });
  try {
    const rec = JSON.parse(fs.readFileSync(a.file, 'utf8'));
    assert.deepStrictEqual({ ...rec, token: typeof rec.token }, { pid: process.pid, host: os.hostname(), home: '/homes/a', broker: 'live', server: SERVER, api: null, account: '7', startedAt: '2026-10-13T13:00:00.000Z', token: 'string' });
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '007', home: '/homes/b' }), err => {
      assert.ok(err instanceof L.AccountLockError);
      assert.match(err.message, new RegExp(`account 7 on broker "live" is already traded by another runner \\(pid ${process.pid} on host .*, harness home /homes/a, started 2026-10-13T13:00:00.000Z\\): one runner per broker account`));
      assert.match(err.message, /one runner can trade several policies/);
      return true;
    });
    assert.strictEqual(JSON.parse(fs.readFileSync(a.file, 'utf8')).home, '/homes/a', 'the refused start left the lock alone');
    const b = L.acquireAccountLock({ env, broker: LIVE, accountId: '8', home: '/homes/b' });
    const c = L.acquireAccountLock({ env, broker: { name: 'other' }, server: 'name:other', accountId: '7', home: '/homes/c' });
    assert.ok(fs.existsSync(b.file) && fs.existsSync(c.file));
    b.release();
    c.release();
    assert.ok(!fs.existsSync(b.file) && !fs.existsSync(c.file));
  } finally {
    a.release();
  }
  assert.ok(!fs.existsSync(a.file), 'released');
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), [], 'no temp files left');
  a.release(); // twice: harmless
  assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: 'x' }), /no valid account id/);
});

test('release removes only its own lock', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const a = L.acquireAccountLock({ env, broker: LIVE, accountId: '7' });
  const other = JSON.stringify({ pid: process.pid, host: os.hostname(), home: '/b', startedAt: 'x', token: 'not-ours' });
  fs.writeFileSync(a.file, other);
  a.release();
  assert.strictEqual(fs.readFileSync(a.file, 'utf8'), other);
});

test('stale locks: a gone pid, or a pid that is no longer an autotrader, on this host is taken over with a log line; a live runner\'s, another host\'s, or an unreadable lock never is', async () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  const host = os.hostname();
  const take = (rec, opts = {}) => {
    fs.writeFileSync(file, typeof rec === 'string' ? rec : JSON.stringify(rec));
    const logs = [];
    const h = L.acquireAccountLock({ env, broker: LIVE, accountId: '7', home: '/homes/new', log: m => logs.push(m), ...opts });
    const mine = JSON.parse(fs.readFileSync(file, 'utf8'));
    h.release();
    return { logs, mine };
  };
  const gone = await deadPid();
  const dead = take({ pid: gone, host, home: '/homes/old', startedAt: '2026-10-12T13:00:00Z' });
  assert.strictEqual(dead.mine.home, '/homes/new');
  assert.match(dead.logs.join('\n'), new RegExp(`account lock: took over .*account-[0-9a-f]{16}-7\\.lock from pid ${gone} \\(harness home /homes/old, started 2026-10-12T13:00:00Z\\): that process is gone`));
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', AUTOTRADER_ARG], { stdio: 'ignore' });
  try {
    await waitFor('the children', 5000, () => other.pid && runner.pid);
    // A reused pid: alive, but not an autotrader.
    const r = take({ pid: other.pid, host, home: '/homes/old' }, { command: () => '/sbin/launchd' });
    assert.match(r.logs.join(), /took over/);
    // A live autotrader (its real command line), another host's lock, an unreadable or pid-less lock: refused, left alone.
    for (const rec of [{ pid: runner.pid, host, home: '/homes/old', startedAt: 't' }, { pid: gone, host: `${host}-other`, home: '/homes/old' }, 'not json', '{"home":"/x"}', '{"pid":"12"}']) {
      const text = typeof rec === 'string' ? rec : JSON.stringify(rec);
      fs.writeFileSync(file, text);
      assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /already traded by another runner/, text);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), text, `left alone: ${text}`);
    }
    fs.writeFileSync(file, 'not json');
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /its lock file is unreadable.*remove .*account-[0-9a-f]{16}-7\.lock/);
  } finally {
    other.kill();
    runner.kill();
  }
  fs.rmSync(file, { force: true });
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), [], 'no temp or aside files left');
});

test('a stale lock replaced by a live runner while it was being judged is put back, never removed', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  const host = os.hostname();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: other.pid, host, home: '/homes/old' }));
    const fresh = JSON.stringify({ pid: process.pid, host, home: '/homes/winner', startedAt: 't', token: 'w' });
    let calls = 0;
    // Judging the old holder: meanwhile another runner took the lock over (its pid: this one, so it reads live).
    const command = () => { calls += 1; if (calls === 1) fs.writeFileSync(file, fresh); return 'not a runner'; };
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7', command }), /pid \d+ on host .*harness home \/homes\/winner/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), fresh, 'the winner\'s lock stands');
  } finally {
    other.kill();
  }
  fs.rmSync(file, { force: true });
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), []);
});

// Two runners starting together: each child waits for the same instant, then acquires and holds.
async function race({ n = 2, seedStale = false } = {}) {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  if (seedStale) {
    fs.mkdirSync(env.FTH_LOCK_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: await deadPid(), host: os.hostname(), home: '/homes/old' }));
  }
  const at = Date.now() + 400;
  const kids = Array.from({ length: n }, (_, i) => child(`
    while (Date.now() < ${at}) {}
    try { const h = L.acquireAccountLock({ env: process.env, broker: { name: 'live' }, accountId: '7', home: '/homes/${i}' }); console.log('WON'); setTimeout(() => h.release(), 300); }
    catch (err) { console.log('REFUSED ' + err.message); }
  `, env));
  await Promise.all(kids.map(k => k.done));
  const outs = kids.map(k => k.io.out.trim());
  assert.ok(!fs.existsSync(file), 'released after');
  return outs;
}

test('atomic acquire: of two runners starting together exactly one gets the lock, also over a stale one', { timeout: 60000 }, async () => {
  for (let round = 0; round < 4; round += 1) {
    for (const seedStale of [false, true]) {
      const outs = await race({ n: 2, seedStale });
      assert.strictEqual(outs.filter(o => o === 'WON').length, 1, `round ${round}${seedStale ? ' (stale)' : ''}: ${outs.join(' | ')}`);
      assert.strictEqual(outs.filter(o => /^REFUSED (account 7 on broker "live" is already traded|another runner is taking over)/.test(o)).length, 1, outs.join(' | '));
    }
  }
  for (let round = 0; round < 3; round += 1) {
    const many = await race({ n: 6, seedStale: true });
    assert.strictEqual(many.filter(o => o === 'WON').length, 1, many.join(' | '));
    assert.ok(many.every(o => o === 'WON' || /^REFUSED (account 7 on broker "live" is already traded|another runner is taking over)/.test(o)), many.join(' | '));
  }
});

test('no lock leak: released on SIGTERM (the runner exits on it) and on a crash; a killed runner\'s lock is taken over', { timeout: 30000 }, async () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  const hold = `const h = L.acquireAccountLock({ env: process.env, broker: { name: 'live' }, accountId: '7' }); console.log('HELD');`;
  // The runner's own signal handling: stop, then exit (scripts/autotrader.js holdLock).
  const term = child(`${hold} process.on('SIGTERM', () => process.exit(130)); setInterval(() => {}, 1000);`, env);
  await waitFor('the lock', 10000, () => term.io.out.includes('HELD'));
  assert.ok(fs.existsSync(file));
  term.p.kill('SIGTERM');
  assert.strictEqual(await term.done, 130);
  assert.ok(!fs.existsSync(file), 'released on SIGTERM');
  const crash = child(`${hold} setTimeout(() => { throw new Error('boom'); }, 50);`, env);
  assert.strictEqual(await crash.done, 1);
  assert.match(crash.io.out, /HELD[\s\S]*boom/);
  assert.ok(!fs.existsSync(file), 'released on a crash');
  const killed = child(`${hold} setInterval(() => {}, 1000);`, env);
  await waitFor('the lock', 10000, () => killed.io.out.includes('HELD'));
  killed.p.kill('SIGKILL');
  await killed.done;
  assert.ok(fs.existsSync(file), 'SIGKILL leaves it');
  const logs = [];
  L.acquireAccountLock({ env, broker: LIVE, accountId: '7', log: m => logs.push(m) }).release();
  assert.match(logs.join(), new RegExp(`took over .* from pid ${killed.p.pid}`));
});

test('lockStatus (preflight, read only): free, held by a live runner, stale, or unreadable', async () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  assert.deepStrictEqual(L.lockStatus({ env, server: SERVER, accountId: '7' }).state, 'free');
  assert.ok(!fs.existsSync(env.FTH_LOCK_DIR) || fs.readdirSync(env.FTH_LOCK_DIR).length === 0, 'reading writes nothing');
  const h = L.acquireAccountLock({ env, broker: LIVE, accountId: '7' });
  assert.strictEqual(L.lockStatus({ env, server: SERVER, accountId: '007', command: () => 'node /x/scripts/autotrader.js' }).state, 'held');
  h.release();
  fs.writeFileSync(h.file, JSON.stringify({ pid: await deadPid(), host: os.hostname() }));
  assert.strictEqual(L.lockStatus({ env, server: SERVER, accountId: '7' }).state, 'stale');
  fs.writeFileSync(h.file, '');
  assert.strictEqual(L.lockStatus({ env, server: SERVER, accountId: '7' }).state, 'unreadable');
  assert.strictEqual(L.lockStatus({ env, server: SERVER, accountId: 'x' }).state, 'free');
});

const guardsOf = env => fs.readdirSync(env.FTH_LOCK_DIR).filter(f => f.includes('.takeover-'));

test('takeover guard: a live taker\'s guard refuses and is left alone; a dead taker\'s guard is passed (one taker) and swept with the stale lock', async () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  const host = os.hostname();
  const stale = JSON.stringify({ pid: await deadPid(), host, home: '/homes/old' });
  fs.writeFileSync(file, stale);
  // Learn the guard's name: a taker that dies in the guard (its unlink fails) leaves it.
  const unlink = fs.unlinkSync;
  fs.unlinkSync = () => { throw Object.assign(new Error('dead taker'), { code: 'EIO' }); };
  try {
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /dead taker/);
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.deepStrictEqual(guardsOf(env), [], 'a taker that fails removes its own guard');
  const guard = `${file}.takeover-${require('crypto').createHash('sha256').update(stale).digest('hex').slice(0, 16)}`;
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', AUTOTRADER_ARG], { stdio: 'ignore' });
  try {
    await waitFor('the child', 5000, () => runner.pid);
    const live = JSON.stringify({ pid: runner.pid, host, home: '/homes/taker' });
    fs.writeFileSync(guard, live);
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), new RegExp(`another runner is taking over .* \\(pid ${runner.pid}\\)`));
    assert.strictEqual(fs.readFileSync(guard, 'utf8'), live, 'a live taker\'s guard stands');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), stale);
  } finally {
    runner.kill();
  }
  // Its taker died: the next one passes it by a guard named after it, takes over, and sweeps both.
  fs.writeFileSync(guard, JSON.stringify({ pid: await deadPid(), host, home: '/homes/taker' }));
  const logs = [];
  const h = L.acquireAccountLock({ env, broker: LIVE, accountId: '7', log: m => logs.push(m) });
  assert.match(logs.join(), /took over/);
  assert.deepStrictEqual(guardsOf(env), [], 'every guard of the stale lock swept');
  h.release();
  // An unreadable guard can't be judged: refused.
  fs.writeFileSync(file, stale);
  fs.writeFileSync(guard, 'junk');
  assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /another runner is taking over/);
});

test('the three-way takeover: B judged the lock stale, A took it over meanwhile, C starts in B\'s window - one holder, A, always', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  const host = os.hostname();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const link = fs.linkSync;
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: other.pid, host, home: '/homes/old' }));
    let a = null;
    let c = null;
    // B, judging the stale holder (alive, not an autotrader), lets A take over in full; then, at B's every hard link
    // (its guard, its lock), C tries to start.
    const command = () => {
      if (!a) a = L.acquireAccountLock({ env, broker: LIVE, accountId: '7', home: '/homes/A', command: () => 'not a runner' });
      return 'not a runner';
    };
    fs.linkSync = (src, dst) => {
      if (a && !c && src.includes('.tmp')) {
        fs.linkSync = link;
        try { c = L.acquireAccountLock({ env, broker: LIVE, accountId: '7', home: '/homes/C' }); } catch (err) { c = err; }
        fs.linkSync = (s2, d2) => link(s2, d2);
      }
      return link(src, dst);
    };
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7', home: '/homes/B', command }), /already traded by another runner .*harness home \/homes\/A/);
    fs.linkSync = link;
    assert.ok(c instanceof L.AccountLockError, `C is refused: ${c && c.message}`);
    assert.match(c.message, /harness home \/homes\/A/);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).home, '/homes/A', 'A\'s lock stands');
    assert.strictEqual(a.held(), true);
    a.release();
  } finally {
    fs.linkSync = link;
    other.kill();
  }
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), []);
});

test('an unwritable lock directory: an account-lock message, never a raw error', { skip: process.getuid && process.getuid() === 0 ? 'root writes anywhere' : false }, () => {
  const base = tmpDir();
  fs.chmodSync(base, 0o500);
  try {
    const env = { FTH_LOCK_DIR: path.join(base, 'locks'), FTH_TEST_LOCKS: '1' };
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /the account lock directory .*locks can't be written \(EACCES\)/);
    assert.match(L.lockDirWritable(env.FTH_LOCK_DIR), /can't be written \(EACCES\)/);
  } finally {
    fs.chmodSync(base, 0o700);
  }
  assert.strictEqual(L.lockDirWritable(path.join(base, 'a', 'b')), null, 'a directory still to be made, under a writable one');
});

test('a directory without hard links is refused (no non-atomic fallback); the lock does not read back as ours: refused', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const link = fs.linkSync;
  fs.linkSync = () => { const e = new Error('no links'); e.code = 'EPERM'; throw e; };
  try {
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /can't hold hard links \(EPERM\).*local disk/);
  } finally {
    fs.linkSync = link;
  }
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), [], 'nothing created');
  fs.linkSync = (a, b) => { link(a, b); fs.writeFileSync(b, JSON.stringify({ pid: 1, token: 'other' })); };
  try {
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /did not read back as this runner's/);
  } finally {
    fs.linkSync = link;
  }
});

test('held(): lost only when the file is gone or names another holder - a read that fails is not a loss', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const h = L.acquireAccountLock({ env, broker: LIVE, accountId: '7' });
  const read = fs.readFileSync;
  fs.readFileSync = (f, ...rest) => { if (f === h.file) throw Object.assign(new Error('too many files'), { code: 'EMFILE' }); return read(f, ...rest); };
  try {
    assert.strictEqual(h.held(), true, 'EMFILE: still ours');
  } finally {
    fs.readFileSync = read;
  }
  fs.writeFileSync(h.file, 'junk');
  assert.strictEqual(h.held(), false, 'overwritten');
  fs.rmSync(h.file);
  assert.strictEqual(h.held(), false, 'removed');
  h.release();
});

test('lockRefusal: never advises removing a live runner\'s lock; another host\'s is stopped there; an unreadable one is checked, then removed', () => {
  const host = os.hostname();
  const here = L.lockRefusal({ pid: 5, host, home: '/h', startedAt: 't' }, '/l/f.lock', { broker: LIVE, accountId: '7' });
  assert.match(here, /pid 5 on host .*harness home \/h, started t\): one runner per broker account.*never remove the file of one that runs/);
  assert.doesNotMatch(here, /remove \/l\/f\.lock/);
  const there = L.lockRefusal({ pid: 5, host: 'elsewhere', home: '/h' }, '/l/f.lock', { broker: LIVE, accountId: '7' });
  assert.match(there, /That runner is on host elsewhere: stop it there/);
  assert.doesNotMatch(there, /remove \/l\/f\.lock/);
  assert.match(L.lockRefusal(null, '/l/f.lock', { broker: LIVE, accountId: '7' }), /unreadable.*Check that no runner trades it, then remove \/l\/f\.lock/);
});

test('release: a lock it can\'t read is left (taken over as stale at the next start), never removed blind', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const h = L.acquireAccountLock({ env, broker: LIVE, accountId: '7' });
  const read = fs.readFileSync;
  fs.readFileSync = (f, ...rest) => { if (f === h.file) throw Object.assign(new Error('io'), { code: 'EIO' }); return read(f, ...rest); };
  try {
    h.release();
  } finally {
    fs.readFileSync = read;
  }
  assert.ok(fs.existsSync(h.file), 'left');
  fs.rmSync(h.file);
});

test('serverIdentities: the API the broker config names (apiUrlEnv) is a key before the server starts; the path as the disk spells it', () => {
  const broker = { name: 'live', command: ['srv'], apiUrlEnv: 'LIVE_API_URL' };
  assert.deepStrictEqual(L.serverIdentities({ broker, env: { LIVE_API_URL: 'https://API.example.test/' } }), ['cmd:srv', 'api:https://api.example.test']);
  assert.deepStrictEqual(L.serverIdentities({ broker, env: {}, config: { apiUrl: 'https://api.example.test' } }), ['cmd:srv', 'api:https://api.example.test']);
  assert.deepStrictEqual(L.serverIdentities({ broker, env: { LIVE_API_URL: 'https://a.test' }, config: { apiUrl: 'https://b.test' } }), ['cmd:srv', 'api:https://a.test', 'api:https://b.test'], 'both, when they differ');
  assert.strictEqual(L.configuredApi({ apiUrlEnv: '' }, { '': 'x' }), '');
  // Case: on a case-insensitive disk, another spelling of the path is the same server.
  const dir = tmpDir();
  const entry = path.join(dir, 'Server.js');
  fs.writeFileSync(entry, '');
  const other = path.join(dir, 'server.js');
  if (fs.existsSync(other)) {
    assert.deepStrictEqual(L.serverIdentities({ broker: { command: ['node', other] } }), L.serverIdentities({ broker: { command: ['node', entry] } }));
  }
});

test('ensure(): held; a read that fails is held; taken only on positive identification, twice; everything else unknown', async () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const lock = L.acquireAccountLocks({ env, broker: LIVE, servers: ['cmd:/s', 'api:https://api.example.test'], accountId: '7' });
  const fast = { stableMs: 0 };
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', AUTOTRADER_ARG], { stdio: 'ignore' });
  const plain = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await waitFor('the children', 5000, () => runner.pid && plain.pid);
    assert.strictEqual(await lock.ensure(fast), 'held');
    // A read that fails is no loss.
    const read = fs.readFileSync;
    fs.readFileSync = (f, ...rest) => { if (f === lock.files[0]) throw Object.assign(new Error('io'), { code: 'EIO' }); return read(f, ...rest); };
    try {
      assert.strictEqual(await lock.ensure(fast), 'held');
    } finally {
      fs.readFileSync = read;
    }
    const other = pid => JSON.stringify({ pid, host: os.hostname(), home: '/homes/b', token: 'theirs' });
    const both = text => lock.files.forEach(f => fs.writeFileSync(f, text));
    both(other(runner.pid));
    assert.strictEqual(await lock.ensure(fast), 'taken', 'another autotrader on this host, live, on every key');
    // Changed between the two reads (a race): unknown.
    let n = 0;
    assert.strictEqual(await lock.ensure({ stableMs: 0, wait: async () => { n += 1; if (n === 1) fs.writeFileSync(lock.files[0], other(plain.pid)); } }), 'unknown');
    both(other(runner.pid));
    for (const [why, text, opts] of [
      ['a pid that is not an autotrader', other(plain.pid), fast],
      ['a pid whose command can\'t be read', other(runner.pid), { stableMs: 0, command: () => null }],
      ['another host', JSON.stringify({ pid: runner.pid, host: `${os.hostname()}-other`, token: 'theirs' }), fast],
      ['a gone pid', other(2 ** 30), fast],
      ['our own pid, another token', other(process.pid), { stableMs: 0, command: () => 'node /x/scripts/autotrader.js' }],
      ['junk', 'junk', fast],
    ]) {
      both(text);
      // Not identified: unknown at once, no second read awaited.
      assert.strictEqual(await lock.ensure({ ...opts, wait: async () => assert.fail(`${why}: waited`) }), 'unknown', why);
      assert.strictEqual(fs.readFileSync(lock.files[0], 'utf8'), text, `${why}: never overwritten`);
    }
    // Keys that disagree: unknown, never an exit.
    fs.writeFileSync(lock.files[0], other(runner.pid));
    fs.rmSync(lock.files[1]);
    assert.strictEqual(await lock.ensure(fast), 'unknown');
  } finally {
    runner.kill();
    plain.kill();
    lock.release();
  }
  assert.strictEqual(await lock.ensure(fast), 'unknown', 'released');
  for (const f of fs.readdirSync(env.FTH_LOCK_DIR)) fs.rmSync(path.join(env.FTH_LOCK_DIR, f));
});

test('ensure(): a file of ours that vanished is linked back only when it stays gone, and only when ours reads back; never an exit', async () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const lock = L.acquireAccountLocks({ env, broker: LIVE, servers: ['cmd:/s'], accountId: '7' });
  const [file] = lock.files;
  const kept = fs.readFileSync(file, 'utf8');
  fs.rmSync(file);
  assert.strictEqual(await lock.ensure({ stableMs: 0 }), 'relinked');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), kept, 'our own record, as it was');
  assert.strictEqual(await lock.ensure({ stableMs: 0 }), 'held');
  // Gone, then another runner's in its place before the re-read: unknown, theirs left alone.
  fs.rmSync(file);
  const theirs = JSON.stringify({ pid: 2 ** 30, host: os.hostname(), token: 'theirs' });
  assert.strictEqual(await lock.ensure({ stableMs: 0, wait: async () => fs.writeFileSync(file, theirs) }), 'unknown');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), theirs);
  // Linked, but what reads back isn't ours (another runner swapped it in): unknown.
  fs.rmSync(file);
  const link = fs.linkSync;
  fs.linkSync = (src, dst) => { link(src, dst); fs.writeFileSync(dst, theirs); };
  try {
    assert.strictEqual(await lock.ensure({ stableMs: 0 }), 'unknown');
  } finally {
    fs.linkSync = link;
  }
  fs.rmSync(file);
  lock.release();
  assert.deepStrictEqual(fs.readdirSync(env.FTH_LOCK_DIR), []);
});

test('the pre-start check refuses an unreadable lock as a held one (it can\'t be judged)', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1', LIVE_API_URL: 'https://api.example.test' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'junk');
  assert.throws(() => L.checkAccountLock({ env, broker: LIVE, accountId: '7' }), /its lock file is unreadable/);
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname() }));
  assert.doesNotThrow(() => L.checkAccountLock({ env, broker: LIVE, accountId: '7' }), 'stale: taken over at start');
});

test('a taker\'s guard is removed only while it is its own: a guard someone else holds by then stands', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname(), home: '/homes/old' }));
  const link = fs.linkSync;
  const foreign = JSON.stringify({ pid: process.pid, host: os.hostname(), home: '/homes/other', token: 'theirs' });
  let guard = null;
  // Once our guard is placed: the lock changes to a live runner's, and our guard is swapped for another's.
  fs.linkSync = (src, dst) => {
    link(src, dst);
    if (dst.includes('.takeover-') && !guard) {
      guard = dst;
      fs.writeFileSync(file, foreign);
      fs.rmSync(dst);
      fs.writeFileSync(dst, foreign);
    }
  };
  try {
    assert.throws(() => L.acquireAccountLock({ env, broker: LIVE, accountId: '7' }), /already traded by another runner .*harness home \/homes\/other/);
  } finally {
    fs.linkSync = link;
  }
  assert.ok(guard, 'a guard was placed');
  assert.strictEqual(fs.readFileSync(guard, 'utf8'), foreign, 'the other taker\'s guard stands');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), foreign);
});

test('apiUrlEnvProblem: a live broker names a set apiUrlEnv among its env variables, never a credential; the pre-start check refuses otherwise', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1', LIVE_API_URL: 'https://api.example.test', LIVE_API_KEY: 'k', LIVE_TOKEN_URL: 'https://t.test' };
  assert.strictEqual(L.apiUrlEnvProblem(LIVE, env), null);
  const cases = [
    [{ name: 'live' }, /names no apiUrlEnv/],
    [{ name: 'live', apiUrlEnv: '  ', env: ['LIVE_API_URL'] }, /names no apiUrlEnv/],
    [{ name: 'live', apiUrlEnv: 'LIVE_API_URL', env: [] }, /apiUrlEnv LIVE_API_URL is not one of its env variables/],
    [{ name: 'live', apiUrlEnv: 'LIVE_API_KEY', env: ['LIVE_API_KEY'] }, /apiUrlEnv LIVE_API_KEY looks like a credential/],
    [{ name: 'live', apiUrlEnv: 'LIVE_SECRET', env: ['LIVE_SECRET'] }, /looks like a credential/],
    [{ name: 'live', apiUrlEnv: 'LIVE_PASSWORD', env: ['LIVE_PASSWORD'] }, /looks like a credential/],
    [{ name: 'live', apiUrlEnv: 'LIVE_USERNAME', env: ['LIVE_USERNAME'] }, /looks like a credential/],
  ];
  for (const [broker, why] of cases) {
    assert.match(L.apiUrlEnvProblem(broker, env), why, JSON.stringify(broker));
    assert.throws(() => L.checkAccountLock({ env, broker, accountId: '7' }), why);
  }
  assert.strictEqual(L.apiUrlEnvProblem({ name: 'live', apiUrlEnv: 'LIVE_TOKEN_URL', env: ['LIVE_TOKEN_URL'] }, env), null, 'a URL is never a credential');
  assert.match(L.apiUrlEnvProblem(LIVE, { ...env, LIVE_API_URL: '' }), /LIVE_API_URL is empty/);
  assert.doesNotThrow(() => L.checkAccountLock({ env, broker: LIVE, accountId: '7' }));
});

test('the shipped live broker names its API URL variable (one of its env), and an override can\'t change it', () => {
  const { DEFAULTS_FILE, loadBrokers } = require('../../scripts/lib/broker/config');
  const shipped = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
  const live = Object.entries(shipped.brokers).filter(([, b]) => b.replay !== true);
  assert.ok(live.length > 0);
  for (const [name, b] of live) assert.strictEqual(L.apiUrlEnvProblem({ name, ...b }, { [b.apiUrlEnv]: 'https://x.test' }), null, name);
  const home = tmpDir();
  const [name, b] = live[0];
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ brokers: { [name]: { apiUrlEnv: b.env.find(v => v !== b.apiUrlEnv) } } }));
  assert.strictEqual(loadBrokers({ FTH_BROKERS_FILE: path.join(home, 'brokers.json') }).brokers[name].apiUrlEnv, b.apiUrlEnv);
});

test('heldByRunner (the gate outside a runner): an entry on an account a live runner holds is refused; free, stale, or another account, not', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1', LIVE_API_URL: 'https://api.example.test' };
  assert.strictEqual(L.heldByRunner({ env, broker: LIVE, accountId: '7' }), null, 'free');
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', AUTOTRADER_ARG], { stdio: 'ignore' });
  const file = L.lockFileFor({ env, server: 'api:https://api.example.test', accountId: '7' });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: runner.pid, host: os.hostname(), home: '/homes/a', startedAt: 't', token: 'x' }));
    assert.match(L.heldByRunner({ env, broker: LIVE, accountId: '007' }), new RegExp(`already traded by another runner \\(pid ${runner.pid}.*Entries from another session are refused`));
    assert.strictEqual(L.heldByRunner({ env, broker: LIVE, accountId: '8' }), null, 'another account');
    for (const bad of ['x', '', null, undefined]) assert.match(L.heldByRunner({ env, broker: LIVE, accountId: bad }), /names no valid accountId .*no entry/, String(bad));
    // An override outside tests is never read, never a pass: the default lock dir (under the OS home) is checked.
    const home = tmpDir();
    const untested = { ...env, FTH_TEST_LOCKS: '' };
    assert.strictEqual(L.heldByRunner({ env: untested, broker: LIVE, accountId: '7', home }), null, 'the default dir: free');
    const dflt = L.lockFileFor({ env: {}, server: 'api:https://api.example.test', accountId: '7', home });
    fs.mkdirSync(path.dirname(dflt), { recursive: true });
    fs.writeFileSync(dflt, JSON.stringify({ pid: runner.pid, host: os.hostname(), home: '/homes/a', startedAt: 't', token: 'x' }));
    assert.match(L.heldByRunner({ env: untested, broker: LIVE, accountId: '7', home }), /already traded by another runner/, 'held in the default dir: refused, the override ignored');
    fs.rmSync(dflt);
    fs.writeFileSync(dflt, 'junk');
    assert.match(L.heldByRunner({ env: untested, broker: LIVE, accountId: '7', home }), /unreadable/);
  } finally {
    runner.kill();
  }
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname() }));
  assert.strictEqual(L.heldByRunner({ env, broker: LIVE, accountId: '7' }), null, 'stale');
});

test('normApi: the origin only - scheme and host lowercased, a default port dropped, a path ignored; anything unparseable is none', () => {
  for (const u of ['https://h.test', 'https://H.test/', 'https://h.test:443', 'https://h.test/api', 'HTTPS://h.test/api/v1?x=1', ' https://h.test ']) {
    assert.strictEqual(L.normApi(u), 'https://h.test', u);
  }
  assert.strictEqual(L.normApi('https://h.test:8443/api'), 'https://h.test:8443');
  assert.strictEqual(L.normApi('http://h.test:80'), 'http://h.test');
  assert.notStrictEqual(L.normApi('http://h.test'), L.normApi('https://h.test'));
  for (const bad of ['', '  ', 'not a url', 'h.test', null, 7, 'file:///x', 'mailto:a@b.test']) assert.strictEqual(L.normApi(bad), '', String(bad));
  const broker = { name: 'live', command: ['srv'], apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_API_URL'] };
  assert.deepStrictEqual(L.serverIdentities({ broker, env: { LIVE_API_URL: 'https://h.test:443/api' }, config: { apiUrl: 'https://H.TEST' } }), ['cmd:srv', 'api:https://h.test']);
  assert.match(L.apiUrlEnvProblem(broker, { LIVE_API_URL: 'h.test' }), /LIVE_API_URL \("h\.test"\) is not a URL with a host/);
});

test('heldByRunner: an unreadable lock refuses an entry (as at a runner\'s start); an apiUrlEnv value that is no URL can\'t be judged, so it refuses too', () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1', LIVE_API_URL: 'https://api.example.test' };
  const file = L.lockFileFor({ env, server: SERVER, accountId: '7' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'junk');
  assert.match(L.heldByRunner({ env, broker: LIVE, accountId: '7' }), /its lock file is unreadable.*Entries from another session are refused/);
  fs.rmSync(file);
  assert.strictEqual(L.heldByRunner({ env, broker: LIVE, accountId: '7' }), null);
  assert.match(L.heldByRunner({ env: { ...env, LIVE_API_URL: 'nonsense' }, broker: LIVE, accountId: '7' }), /LIVE_API_URL is not a URL with a host, .*no entry/);
  assert.match(L.heldByRunner({ env: { ...env, LIVE_API_URL: '' }, broker: LIVE, accountId: '7' }), /broker "live": LIVE_API_URL is not set, .*no entry\. Set LIVE_API_URL/, 'a live broker without its API URL: unknown');
  assert.strictEqual(L.heldByRunner({ env: { ...env, LIVE_API_URL: '' }, broker: { name: 'sim', command: ['sim-mcp'] }, accountId: '7' }), null, 'a broker with no apiUrlEnv (replay): its command key alone');
});

test('a lock file with our token but another pid is not ours: never held, never removed', async () => {
  const env = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const lock = L.acquireAccountLocks({ env, broker: LIVE, servers: ['cmd:/s'], accountId: '7' });
  const [file] = lock.files;
  const forged = JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pid: process.pid + 1 });
  fs.writeFileSync(file, forged);
  assert.strictEqual(lock.held(), false);
  assert.strictEqual(await lock.ensure({ stableMs: 0 }), 'unknown');
  lock.release();
  assert.strictEqual(fs.readFileSync(file, 'utf8'), forged, 'left alone');
  fs.rmSync(file);
});
