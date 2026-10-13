'use strict';

/**
 * One runner per broker account, across every harness home of this user. The
 * runner's own lock (runner-lock.js) is per home (<FTH_HOME>/autotrader.lock),
 * so two homes could each start a runner on the same account; this lock is
 * shared by all of them: <default harness home>/locks/ under the OS account's
 * home directory (os.userInfo(), so neither FTH_HOME nor HOME moves it; another
 * OS user has other locks). FTH_LOCK_DIR moves it for tests only: it is honoured
 * with FTH_TEST_LOCKS=1, and otherwise a live run refuses to start (an override
 * would hide runners from each other, so it fails closed instead of warning).
 *
 * One file per broker server and account id (normalized as the gate compares
 * them: "007" is account 7). The server is who it is, not what brokers.json calls
 * it: its resolved command (real paths as the disk spells them, any node) and the
 * API the broker config names (`apiUrlEnv`), both known before it is started, so a
 * refused runner never starts (or logs in to) a second server; and, once it
 * answers, the API it trades (get_server_config `apiUrl`, which a live run
 * requires), so two installs of a server on one API are one account too. A run
 * holds every one of its keys, and records the API in each. One runner may still
 * trade several policies: the lock is the account's.
 *
 * A lock file holds { pid, host, home, broker, server, account, startedAt, token }.
 * It is created atomically (written aside, then hard-linked into place, which
 * fails if the file exists; a directory without hard links is refused, never a
 * weaker create) and read back by token; the runner re-reads it before every pass
 * (ensure(): a file of its own that vanished and stayed gone is linked back; one
 * another runner holds, positively identified twice ('taken'), makes it exit without
 * a broker action, the holder manages the account; anything else ('unknown') makes
 * it stop new entries (the kill switch) and keep full risk management of the
 * account, alerting every pass),
 * and the order gate re-reads it before every entry of the runner's cycles
 * (FTH_ACCOUNT_LOCK, lockGateRefusal); outside a runner the gate refuses entries on
 * an account a live runner holds (heldByRunner). A lock whose pid is gone on this host (or is no longer an autotrader)
 * is stale: it is removed only under a takeover guard (`<file>.takeover-<hash of
 * the stale lock>`, hard-linked: one taker at a time), after re-reading it
 * unchanged, with a log line. A guard whose holder died is passed by a guard named
 * after it (one taker again), and every guard of the stale lock is swept once it
 * is replaced. A live holder's lock or guard, one from another host, or an
 * unreadable one is never taken over: a false refusal is safe, two holders never.
 *
 * Paper runs (the broker server refuses every order) and confirmed replays (the
 * broker config and its server both say replay, as liveRunBlocked judges) are
 * exempt: they never take or check the lock, so a replay never blocks live.
 *
 *   lockDir(env, home)                         the shared lock directory
 *   lockDirProblem(env)                        why the lock directory may not be used (an untested override), or null
 *   lockDirWritable(dir)                       null, or why it can't be written (preflight)
 *   configuredApi(broker, env)                 the API URL the broker config names (`apiUrlEnv`), before the server starts
 *   serverIdentities({ broker, config, env })  ['cmd:<real paths>' | 'name:<broker>', 'api:<configured url>'?, 'api:<reported url>'?]
 *   apiUrlEnvProblem(broker, env)              why a live broker's apiUrlEnv can't key the pre-start check, or null
 *   heldByRunner({ env, broker, accountId })   the gate outside a runner: why an entry is refused (a live runner holds the account,
 *                                              no valid account id); a lock dir override outside tests is ignored, never a pass
 *   lockSpec(lock)                             FTH_ACCOUNT_LOCK for the runner's cycles (files and token, or 'none')
 *   lockGateRefusal(raw, accountId)            the gate's hard check on FTH_ACCOUNT_LOCK: why an entry (on accountId) is refused, or null
 *   lockFileFor({ env, server, accountId })    one key's lock file, or null for an invalid account id
 *   lockExemption({ paper, broker, config })   'paper' | 'replay' | null
 *   readLock(file)                             { lock, raw } | null (no file); lock null when unreadable or pid-less
 *   holderAlive(lock, { host, self, command }) the holder may be running (fails closed)
 *   confirmedRunner(lock, { host, self, command })   another runner positively identified (same host, live, an autotrader)
 *   lockRefusal(lock, file, { broker, accountId })   the refusal message
 *   lockStatus({ env, server, accountId })     { file, lock, state: 'free' | 'held' | 'stale' | 'unreadable' }
 *   checkAccountLock({ env, broker, servers, accountId })   throws the refusal when another runner holds a key (read only)
 *   acquireAccountLocks({ env, broker, servers, accountId, home, log, ... })   { files, token, held(), release(),
 *                                              ensure() (async): 'held' | 'relinked' | 'taken' | 'unknown' }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { expandHome, harnessHome } = require('./paths');
const { normId } = require('./broker/allow-list');
const { lockHolderAlive, processCommand, AUTOTRADER } = require('./runner-lock');

class AccountLockError extends Error {}

function osHome() {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch (_err) {
    return os.homedir();
  }
}

function lockDir(env = process.env, home = osHome()) {
  const configured = String(env.FTH_LOCK_DIR || '').trim();
  return configured ? path.resolve(expandHome(configured, home)) : path.join(harnessHome({}, home), 'locks');
}

function lockDirProblem(env = process.env) {
  if (!String(env.FTH_LOCK_DIR || '').trim() || env.FTH_TEST_LOCKS === '1') return null;
  return `FTH_LOCK_DIR is set (${env.FTH_LOCK_DIR}): it moves the shared account locks, so runners would not see each other. It is for tests only (with FTH_TEST_LOCKS=1); unset it`;
}

/** Null when `dir` (or, before it exists, its nearest existing parent) can be written; else why not. */
function lockDirWritable(dir) {
  let d = dir;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return fs.statSync(d).isDirectory() ? null : `${d} is not a directory`;
  } catch (err) {
    return `${d} can't be written (${err.code})`;
  }
}

const brokerName = broker => String((broker && broker.name) || 'broker');
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

const realOrSelf = p => {
  try {
    return fs.realpathSync.native(p); // the path as the disk spells it: one key whatever case a config uses
  } catch (_err) {
    return p;
  }
};

/**
 * An API URL as its origin (scheme://host[:port], scheme and host lowercased, a default port dropped), or '' when
 * there is none or it doesn't parse. Only the origin keys the lock: a path or query never tells two accounts apart
 * (an account id is the platform's own, whichever endpoint serves it), so https://h, https://h:443 and https://h/api
 * are one API.
 */
function normApi(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  let u;
  try {
    u = new URL(url.trim());
  } catch (_err) {
    return '';
  }
  return u.origin && u.origin !== 'null' ? u.origin.toLowerCase() : '';
}

/** The API the broker config says its server trades, before it is started: `apiUrlEnv` (the variable holding it). */
function configuredApi(broker, env = process.env) {
  const v = broker && typeof broker.apiUrlEnv === 'string' && broker.apiUrlEnv.trim() ? env[broker.apiUrlEnv.trim()] : '';
  return normApi(v);
}

// A variable that may hold a credential is never read as the API URL (it would land in the lock record).
const CREDENTIAL = /key|secret|token|passw(or)?d|user/i;

/**
 * Why a live broker's `apiUrlEnv` can't key the pre-start check, or null: it must be set, name one of the
 * entry's `env` variables, not look like a credential (unless it names a URL or URI), and hold a value.
 */
function apiUrlEnvProblem(broker, env = process.env) {
  const name = broker && typeof broker.apiUrlEnv === 'string' ? broker.apiUrlEnv.trim() : '';
  const who = `broker "${brokerName(broker)}"`;
  if (!name) return `${who} names no apiUrlEnv (the variable holding its API URL, in brokers.json), so the one-runner-per-account check can't run before its server starts: a live run refuses`;
  if (!(Array.isArray(broker.env) && broker.env.map(String).includes(name))) return `${who}: apiUrlEnv ${name} is not one of its env variables: a live run refuses`;
  if (CREDENTIAL.test(name) && !/ur[li]/i.test(name)) return `${who}: apiUrlEnv ${name} looks like a credential, never read as a URL: a live run refuses`;
  if (!String(env[name] || '').trim()) return `${who}: ${name} is empty: set it to the API URL its server trades (a live run refuses without it)`;
  if (!configuredApi(broker, env)) return `${who}: ${name} (${JSON.stringify(String(env[name]))}) is not a URL with a host: a live run refuses`;
  return null;
}

/**
 * The order gate outside a runner (FTH_ACCOUNT_LOCK unset: an interactive session): why an entry on `accountId` is
 * refused because a live runner holds that account's lock, or null. Local state only (the lock files, the pid).
 */
function heldByRunner({ env = process.env, broker, accountId, command, home = osHome() } = {}) {
  if (normId(accountId) === null) return `The order names no valid accountId (${JSON.stringify(accountId)}), so whether a runner trades the account can't be told: no entry. Exits, protective stops, cancels and closes still go.`;
  // A lock dir override outside tests is never read (a runner refuses it): the default lock dir is checked instead.
  const lockEnv = lockDirProblem(env) ? { ...env, FTH_LOCK_DIR: '' } : env;
  // A live broker (one with apiUrlEnv) is known by its API too: without that URL a runner from another install on the
  // same API would go unseen, so the account's lock can't be judged: no entry. A broker without apiUrlEnv (a replay
  // broker) is known by its command alone.
  const name = broker && typeof broker.apiUrlEnv === 'string' ? broker.apiUrlEnv.trim() : '';
  if (name && !configuredApi(broker, env)) {
    const what = String(env[name] || '').trim() ? 'is not a URL with a host' : 'is not set';
    return `broker "${brokerName(broker)}": ${name} ${what}, so whether a runner of another install trades the account can't be told: no entry. Set ${name} to the API URL its server trades. Exits, protective stops, cancels and closes still go.`;
  }
  for (const server of serverIdentities({ broker, env })) {
    const st = lockStatus({ env: lockEnv, server, accountId, command, home });
    // An unreadable lock can't be judged: refused, as at a runner's start (checkAccountLock).
    if (st.state === 'held' || st.state === 'unreadable') return `${lockRefusal(st.lock, st.file, { broker, accountId })} Entries from another session are refused while it runs; exits, protective stops, cancels and closes still go.`;
  }
  return null;
}

function serverIdentities({ broker, config, env = process.env } = {}) {
  const cmd = broker && Array.isArray(broker.command) ? broker.command.map(String) : [];
  // The interpreter is not the server: node from another install runs the same server.
  const args = cmd.length > 1 && (cmd[0] === process.execPath || /^node(\.exe)?$/i.test(path.basename(cmd[0]))) ? cmd.slice(1) : cmd;
  const out = [args.length ? `cmd:${args.map(realOrSelf).join('\0')}` : `name:${brokerName(broker)}`];
  for (const api of [configuredApi(broker, env), normApi(config && config.apiUrl)]) if (api && !out.includes(`api:${api}`)) out.push(`api:${api}`);
  return out;
}

function lockFileFor({ env = process.env, server, accountId, home = osHome() }) {
  const id = normId(accountId);
  if (id === null) return null;
  return path.join(lockDir(env, home), `account-${hash(server || '')}-${id}.lock`);
}

function lockExemption({ paper = false, broker, config }) {
  if (paper === true) return 'paper';
  if (broker && broker.replay === true && config && config.replay === true) return 'replay';
  return null;
}

function readLock(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { lock: null, raw: null };
  }
  try {
    const lock = JSON.parse(raw);
    // A lock that names no pid can't be judged: unreadable (never taken over).
    return { lock: lock && typeof lock === 'object' && Number.isInteger(lock.pid) && lock.pid > 0 ? lock : null, raw };
  } catch (_err) {
    return { lock: null, raw };
  }
}

/**
 * Another runner, positively identified: on this host, its pid alive and its command read as an autotrader's (never
 * assumed: a command that can't be read is no identification). What a running runner exits for (ensure 'taken').
 */
function confirmedRunner(lock, { host = os.hostname(), self = process.pid, command } = {}) {
  if (!lock || lock.host !== host || !Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === self) return false;
  try {
    process.kill(lock.pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  const cmd = (command || processCommand)(lock.pid);
  return typeof cmd === 'string' && AUTOTRADER.test(cmd);
}

/** Live unless its pid is gone (or not an autotrader) on this host. Unjudgeable, another host's, or our own pid: live. */
function holderAlive(lock, { host = os.hostname(), self = process.pid, command } = {}) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return true;
  if (lock.host !== host) return true; // can't see another machine's processes
  if (lock.pid === self) return true;
  return lockHolderAlive(lock, { self: null, ...(command ? { command } : {}) });
}

function lockRefusal(lock, file, { broker, accountId, host = os.hostname() }) {
  const who = lock ? `pid ${lock.pid} on host ${lock.host || '?'}, harness home ${lock.home || '?'}, started ${lock.startedAt || '?'}` : 'its lock file is unreadable';
  // Removing a live runner's lock stops that runner: say so only where the holder can't be seen running.
  const after = !lock ? `Check that no runner trades it, then remove ${file}`
    : lock.host !== host ? `That runner is on host ${lock.host || '?'}: stop it there; its lock goes with it`
      : `A runner that is gone leaves its lock to the next start; never remove the file of one that runs (it stops at once)`;
  return `account ${normId(accountId)} on broker "${brokerName(broker)}" is already traded by another runner (${who}): one runner per broker account. Stop that runner first (or trade another account; one runner can trade several policies). ${after}`;
}

function lockStatus({ env = process.env, server, accountId, host = os.hostname(), command, home = osHome() } = {}) {
  const file = lockFileFor({ env, server, accountId, home });
  if (!file) return { file: null, lock: null, state: 'free' };
  const got = readLock(file);
  if (!got) return { file, lock: null, state: 'free' };
  if (!got.lock) return { file, lock: null, state: 'unreadable' };
  return { file, lock: got.lock, state: holderAlive(got.lock, { host, self: null, command }) ? 'held' : 'stale' };
}

function checkAccountLock({ env = process.env, broker, servers = serverIdentities({ broker, env }), accountId, command }) {
  const problem = lockDirProblem(env) || apiUrlEnvProblem(broker, env);
  if (problem) throw new AccountLockError(problem);
  for (const server of servers) {
    const st = lockStatus({ env, server, accountId, command });
    if (st.state === 'held' || st.state === 'unreadable') throw new AccountLockError(lockRefusal(st.lock, st.file, { broker, accountId }));
  }
}

/** Hard-link `tmp` into place as `file`: false when `file` exists. No hard links: refused (no weaker create). */
function placeLink(tmp, file) {
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    if (['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV', 'EMLINK'].includes(err.code)) {
      throw new AccountLockError(`the account lock directory ${path.dirname(file)} can't hold hard links (${err.code}), which an atomic lock needs: put it on a local disk`);
    }
    throw err;
  }
}

/**
 * Remove the stale lock `raw` under its takeover guard: 'removed', 'changed' (no longer `raw`: judge again), or
 * 'gone'. A live guard refuses; a dead one is passed by a guard named after it.
 */
function removeStale(file, raw, tmp, text, alive) {
  const prefix = `${path.basename(file)}.takeover-${hash(raw)}`;
  let guard = path.join(path.dirname(file), prefix);
  for (let depth = 0; depth < 4; depth += 1) {
    if (placeLink(tmp, guard)) {
      try {
        const now = readLock(file);
        if (!now) return 'gone';
        if (now.raw !== raw) return 'changed';
        fs.unlinkSync(file); // only a guard holder removes another's lock: the file is still `raw`
        for (const f of fs.readdirSync(path.dirname(file))) if (f.startsWith(prefix)) fs.rmSync(path.join(path.dirname(file), f), { force: true });
        return 'removed';
      } finally {
        const g = readLock(guard);
        if (g && g.raw === text) fs.rmSync(guard, { force: true });
      }
    }
    const g = readLock(guard);
    if (!g) continue; // its taker finished: try the same guard again
    if (alive(g.lock)) throw new AccountLockError(`another runner is taking over ${file} (pid ${g.lock ? g.lock.pid : '?'}): try again`);
    guard = `${guard}.${hash(g.raw)}`;
  }
  throw new AccountLockError(`takeovers of ${file} keep failing: if no runner is starting, remove ${file} and ${prefix}* there`);
}

function writeError(err, dir) {
  if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENOSPC'].includes(err.code)) return new AccountLockError(`the account lock directory ${dir} can't be written (${err.code}): the runner can't take the account's lock, so it doesn't start. Fix its permissions`);
  return err;
}

function acquireAccountLock({ env = process.env, broker, server = serverIdentities({ broker, env })[0], accountId, home = harnessHome(env), log = () => {}, host = os.hostname(), command, now = () => new Date(), attempts = 5, token = crypto.randomBytes(8).toString('hex'), api = null }) {
  const problem = lockDirProblem(env);
  if (problem) throw new AccountLockError(problem);
  const file = lockFileFor({ env, server, accountId });
  if (!file) throw new AccountLockError(`no valid account id (${JSON.stringify(accountId)}) to lock`);
  const text = `${JSON.stringify({ pid: process.pid, host, home, broker: brokerName(broker), server, api: api || null, account: normId(accountId), startedAt: now().toISOString(), token })}\n`;
  const tmp = `${file}.${process.pid}-${token}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    throw writeError(err, path.dirname(file));
  }
  const alive = lock => holderAlive(lock, { host, self: process.pid, command });
  try {
    for (let i = 0; i < attempts; i += 1) {
      if (placeLink(tmp, file)) {
        const back = readLock(file);
        if (back && back.lock && back.lock.token === token) return holdHandle(file, token, text);
        throw new AccountLockError(`the account lock ${file} did not read back as this runner's: refused`);
      }
      const got = readLock(file);
      if (!got) continue; // released meanwhile: try again
      if (alive(got.lock)) throw new AccountLockError(lockRefusal(got.lock, file, { broker, accountId }));
      if (removeStale(file, got.raw, tmp, text, alive) === 'removed') log(`account lock: took over ${file} from pid ${got.lock.pid} (harness home ${got.lock.home || '?'}, started ${got.lock.startedAt || '?'}): that process is gone`);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  throw new AccountLockError(`could not take the account lock ${file} (another runner kept changing it): try again`);
}

/**
 * Every key's lock, or none (those taken are released when one is refused), under one token. ensure() (async): 'held';
 * 'relinked' (a file of ours had vanished and stayed gone: put back, read back as ours); 'taken' (every key held by
 * another runner, positively identified, twice); 'unknown' (anything else, keys that disagree included).
 */
function acquireAccountLocks({ servers, token = crypto.randomBytes(8).toString('hex'), ...opts }) {
  const api = (servers.find(x => x.startsWith('api:')) || '').slice(4) || null;
  const held = [];
  try {
    for (const server of servers) held.push(acquireAccountLock({ ...opts, server, token, api }));
  } catch (err) {
    for (const h of held) h.release();
    throw err;
  }
  const ensure = async opts => {
    const states = [];
    for (const h of held) states.push(await h.ensure(opts));
    if (states.every(s => s === 'taken')) return 'taken';
    if (states.some(s => s === 'taken' || s === 'unknown')) return 'unknown';
    return states.includes('relinked') ? 'relinked' : 'held';
  };
  return { files: held.map(h => h.file), token, account: normId(opts.accountId), ensure, held: () => held.every(h => h.held()), release: () => held.forEach(h => h.release()) };
}

/** FTH_ACCOUNT_LOCK for a runner's cycles: the lock files it holds and its token, or 'none' (a run without the lock). */
function lockSpec(lock) {
  return lock ? JSON.stringify({ files: lock.files, token: lock.token, account: lock.account }) : 'none';
}

/**
 * The order gate's check (hard): why an entry is refused under FTH_ACCOUNT_LOCK, or null. Unset: no runner lock is
 * in play (an interactive session). 'none': a cycle that runs without its account's lock (a manual end of day).
 * A spec: every file must still hold the runner's token. Anything unreadable refuses.
 */
function lockGateRefusal(raw, accountId) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!v) return null;
  if (v === 'none') return 'This cycle runs without its account\'s runner lock (a manual end of day, or a run that took none): no new entries; manage, protect and exit only.';
  let spec;
  try { spec = JSON.parse(v); } catch (_err) { spec = null; }
  if (!spec || !Array.isArray(spec.files) || !spec.files.length || typeof spec.token !== 'string' || !spec.token || normId(spec.account) === null) return `FTH_ACCOUNT_LOCK is not a readable lock spec (${v.slice(0, 80)}): no new entries.`;
  // A runner's cycle enters only on the account it holds the lock for: any other account (or one that can't be read) is
  // another runner's to trade, or nobody's checked.
  const id = normId(accountId);
  if (id === null) return `The order names no valid accountId (${JSON.stringify(accountId)}), so it can't be checked against this runner's account (${spec.account}): no entry.`;
  if (id !== normId(spec.account)) return `This runner holds account ${spec.account}'s lock, not account ${id}'s: its cycles enter only on account ${spec.account}. Exits, protective stops, cancels and closes still go.`;
  for (const f of spec.files) {
    const got = readLock(String(f));
    if (!got || !got.lock || got.lock.token !== spec.token) return `The runner no longer holds its account's lock (${f}): another runner trades the account now, or the lock was removed. No new entries; manage, protect and exit only.`;
  }
  return null;
}

/** The lock's release, also run when the process exits (a signal the runner handles, a crash). Only our own lock is removed. */
function holdHandle(file, token, text) {
  let held = true;
  // Lost only when the file is gone or names another holder: a read that fails (EMFILE, EIO) is not a loss.
  // Removed only when it reads as ours: a read that fails leaves it (a stale lock is taken over at the next start).
  const mine = got => Boolean(got && got.lock && got.lock.token === token && got.lock.pid === process.pid);
  const ours = () => {
    const got = readLock(file);
    return Boolean(got && got.raw === null) || mine(got);
  };
  const release = () => {
    if (!held) return;
    held = false;
    process.removeListener('exit', release);
    if (mine(readLock(file))) fs.rmSync(file, { force: true });
  };
  // 'held' (ours, or a read that fails: no loss); 'taken' only on positive identification of another runner, the
  // same on a re-read `stableMs` later; 'relinked' only when the file stayed gone that long and ours reads back;
  // 'unknown' for everything else (another host, a pid whose command can't be read, junk, a race).
  const ensure = async ({ command, stableMs = 1000, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) => {
    if (!held) return 'unknown';
    const got = readLock(file);
    if (got && (got.raw === null || mine(got))) return 'held';
    if (got) {
      if (!confirmedRunner(got.lock, { command })) return 'unknown';
      await wait(stableMs);
      const again = readLock(file);
      return again && again.raw === got.raw && confirmedRunner(again.lock, { command }) ? 'taken' : 'unknown';
    }
    await wait(stableMs); // a runner starting now takes it first: the link below then fails and reads back as not ours
    const tmp = `${file}.${process.pid}-${token}.relink.tmp`;
    try {
      fs.writeFileSync(tmp, text, { flag: 'w', mode: 0o600 });
      placeLink(tmp, file);
    } catch (_err) {
      return 'unknown';
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return mine(readLock(file)) ? 'relinked' : 'unknown';
  };
  process.on('exit', release);
  return { file, release, ensure, held: () => held && ours() };
}

module.exports = { AccountLockError, confirmedRunner, normApi, lockDir, lockDirProblem, lockDirWritable, configuredApi, apiUrlEnvProblem, heldByRunner, serverIdentities, lockSpec, lockGateRefusal, lockFileFor, lockExemption, readLock, holderAlive, lockRefusal, lockStatus, checkAccountLock, acquireAccountLock, acquireAccountLocks };
