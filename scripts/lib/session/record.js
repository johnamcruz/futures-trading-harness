'use strict';

/**
 * A session's decision records, one shape for replay and live (replay/store.js
 * keeps them): what one pass of the runner did, the decision line built from
 * it, the broker's fills joined to the gateway's entries, and the version of
 * the agent that made each decision (the R33 fingerprints that exist today).
 *
 *   passTap()                                   the pass collector: log(fn) and event(fn) wrap the runner's
 *       log and event sinks, bar(symbol, { bar, stale, action }) notes a polled closed bar; begin() starts a
 *       pass, summary(symbols) is { ran, events, errors, bars, values, closed } (the "REPLAY STEP" fields and
 *       the closed bars), events() the raw events
 *   fieldValues(strategies, bars, i)            { strategy: { path: value | null } }: the broker field values each
 *                                               strategy reads on bar i (rules.js valuesFor), only those that read one
 *   failedRun(r)                                a ran cycle that counts as a failed run (not a premarket's, as live)
 *   noDecision(ran)                             a cycle in the pass made no decision (replay runs its time again)
 *   decisionRecord({ t, day, kind, pass, step, cycles, refusals, trades, since, killSwitch, stale, premarketUnavailable,
 *       premarketAvailableAt, premarketRetryStarved })   the line
 *   gateReader(file)                            { refusalsSince(ms) }: the gate log read on from where it left off
 *   killSwitchReason(file)                      the kill switch's latest line ('' when empty), null when off
 *   withEntry(fill, entries, specOf)            an opening fill with the entry the gateway recorded (setup, stop)
 *   fillsBetween(client, account, since, until, { entries, specOf })   the fills in (since, until], with entries
 *   brokerFingerprint(env)                      { broker, error, warning }: the active broker's settings, or why they
 *                                               can't be had; warning names the allowlisted settings dropped as credentials
 *   fingerprints(root, { code, broker, error }) { v, code, harness, strategies, accounts, policy, rulebook, broker,
 *                                               fingerprintError? } (code:
 *                                               a digest already taken, e.g. at process start; broker: the broker's
 *                                               bar-shaping settings, broker/config.js fingerprintSettings, else null)
 *   noteVersion(manifest, { since, hash, fingerprints })   adds a version when the hash or fingerprints changed
 *   versionAt(manifest, t)                      the version that made the decision at t
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { contractRoot } = require('../trading/journal');
const { toRefusal } = require('../replay/store');
const { valuesFor } = require('../trading/rules');
const { activeBroker, fingerprintSettings, fingerprintNames, CREDENTIAL } = require('../broker/config');

/** Collects what one pass of the runner did, from its log and event sinks (wrapped, never replaced). */
function passTap() {
  let events = [];
  let errors = [];
  let closed = new Set();
  return {
    log: fn => (msg, level) => {
      if (level === 'error') errors.push(String(msg).slice(0, 300));
      return fn(msg, level);
    },
    event: fn => ev => {
      events.push(ev);
      return fn(ev);
    },
    // A closed bar; or (with `values`) the field values its scan read, joined to the symbol's bar of this pass.
    bar: (symbol, info = {}) => {
      const own = info.values ? [...closed].filter(c => c.symbol === symbol).pop() : null;
      if (own) Object.assign(own, { contractId: info.contractId || null, values: info.values });
      else closed.add({ symbol, bar: info.bar || null, stale: Boolean(info.stale), action: info.action || null, ...(info.values ? { contractId: info.contractId || null, values: info.values } : {}) });
    },
    begin() {
      events = [];
      errors = [];
      closed = new Set();
    },
    events: () => events.slice(),
    summary: symbols => ({
      ran: events.filter(e => e.kind === 'cycle_end').map(e => ({ action: e.action, ok: e.ok, timedOut: e.timedOut, result: e.result, symbols: e.symbols || null, ...(e.agentError ? { agentError: true } : {}), ...(e.premarketRetry ? { premarketRetry: true } : {}) })),
      events: [...new Set(events.map(e => e.kind))],
      errors: errors.slice(),
      bars: symbols.map(s => ({ symbol: s.symbol, lastBarT: (s.clock && s.clock.lastBarT) || null })),
      // The broker field values the strategies read on each closed bar (R35), as the runner's wiring took them.
      values: [...closed].filter(c => c.values).map(c => ({ symbol: c.symbol, contractId: c.contractId, barT: c.bar, strategies: c.values })),
      closed: [...closed],
    }),
  };
}

/**
 * Whether a pass's cycles (passTap summary ran) include one that made no decision: an infrastructure failure
 * (no CYCLE RESULT line, a failed or timed-out harness, a malformed result). The agent's own error result is a
 * decision, and a premarket run's failure (the first or a retry) is no failed run, as live (runner.js): neither counts.
 */
const failedRun = r => Boolean(r) && !r.ok && r.action !== 'premarket';
const noDecision = ran => (ran || []).some(r => failedRun(r) && !r.agentError);

/**
 * The broker field values each strategy reads on bar i (its rules, stop and target: rules.js valuesFor), a
 * missing one null; only the strategies that read one.
 */
function fieldValues(strategies, bars, i = (bars || []).length - 1) {
  const out = {};
  for (const s of strategies || []) {
    const v = valuesFor([s.rules, s.risk, s.exit], bars || [], i);
    if (Object.keys(v).length) out[s.name] = v;
  }
  return out;
}

/** One decision line (replay/store.js appendRecord adds its version `v`); `values` the pass's closed bars' (R35). */
function decisionRecord({ t, day, kind, pass, step, cycles, refusals, trades, since, killSwitch = null, stale = [], premarketUnavailable = null, premarketAvailableAt = null, premarketRetryStarved = 0 }) {
  return {
    t, day, kind, asked: pass.asked, ran: pass.ran || [], events: pass.events || [], step, cycles, refusals,
    errors: pass.errors || [], bars: pass.bars || [], values: pass.values || [], trades, since,
    ...(killSwitch !== null ? { killSwitch: killSwitch || 'on' } : {}),
    // Live only: the symbols whose bar closed too long ago to start a cycle (a slow previous pass), housekeeping only.
    ...(stale && stale.length ? { stale } : {}),
    // The day's premarket failed until its session opened (runner.js): this decision had no premarket plan.
    ...(premarketUnavailable ? { premarketUnavailable } : {}),
    // When a premarket retry produced the day's plan after it was unavailable (the decisions after it have it).
    ...(premarketAvailableAt ? { premarketAvailableAt } : {}),
    // The day's premarket retries skipped or cut short by the next bar so far (runner.js retryPremarket).
    ...(premarketRetryStarved > 0 ? { premarketRetryStarved } : {}),
  };
}

/** The kill switch's latest line ('' when empty or unreadable) when the file exists, else null. */
function killSwitchReason(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length ? `${lines[lines.length - 1].slice(0, 300)}${lines.length > 1 ? ` (and ${lines.length - 1} earlier line${lines.length > 2 ? 's' : ''})` : ''}` : '';
  } catch (_err) {
    return '';
  }
}

/**
 * An opening fill matched to the entry the gateway recorded (its strategy and stop), for R, at the
 * tick value the broker reported (specOf: the home's recorded broker specs), as the gate sized it.
 */
function withEntry(fill, entries, specOf = () => null) {
  const e = fill.profitAndLoss === null || fill.profitAndLoss === undefined ? entries.find(x => String(x.orderId) === String(fill.orderId)) : null;
  if (!e) return fill;
  const spec = specOf(contractRoot(fill.contractId));
  return { ...fill, entry: { setup: e.setup || null, stopTicks: e.stopTicks || null, tickValue: spec ? spec.tickValue : null } };
}

/** The account's fills (search_trades through the broker adapter) in (since, until], each with its entry. */
async function fillsBetween(client, account, since, until, { entries = [], specOf = () => null } = {}) {
  const fills = await client.fillsSince(account, since);
  return fills.filter(f => Date.parse(f.creationTimestamp) > since.getTime() && Date.parse(f.creationTimestamp) <= until.getTime()).map(f => withEntry(f, entries, specOf));
}

// What the agents and the gate read (the replay config hash covers the same folders).
const HARNESS_DIRS = ['strategies', 'accounts', 'skills', 'agents', 'rules'];
// The code the runner, the gate, the rules and the sizing run on: every script, the hooks and scripts/lib.
const CODE_DIRS = ['scripts'];

/** sha256 over every file under the given folders of the harness, by path and bytes. */
function treeDigest(root, dirs) {
  const h = crypto.createHash('sha256');
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_err) { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.name.startsWith('.')) continue; // .DS_Store and the like aren't the harness
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) h.update(`${path.relative(root, p)}\0`).update(fs.readFileSync(p));
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return h.digest('hex');
}

/**
 * The version of the agent (docs/LEARNED-RULEBOOK.md R33), as far as it exists today: `code` hashes
 * scripts/ (the CLIs, hooks and scripts/lib: a superset of R33's code hash), `harness` the documents the cycles read (the replay
 * config hash's tree), `broker` the settings of the broker's server that shape its bars (its brokers.json
 * `fingerprintEnv` allowlist, R35; never a credential), each value an HMAC keyed on the harness home's own
 * salt: two sessions of one home (a live home's days, or a replay run's) can be checked for the same
 * settings; a live session and a replay run (each run home has its own salt) can't, by these digests.
 * `fingerprintError` (when the broker's settings couldn't be fingerprinted, e.g. an unreadable salt) marks
 * a version whose broker settings are unknown: never the same as another's. R33's canonical strategy,
 * account and policy fingerprints and the rulebook seal are not built yet: null until they are.
 */
function fingerprints(root, { code, broker = null, error = null } = {}) {
  const of = dirs => (root ? treeDigest(root, dirs) : null);
  return { v: 1, code: code === undefined ? of(CODE_DIRS) : code, harness: of(HARNESS_DIRS), strategies: null, accounts: null, policy: null, rulebook: null, broker, ...(error ? { fingerprintError: error } : {}) };
}

/**
 * The active broker's bar-shaping settings for the fingerprints: { broker, error }. No broker configured:
 * none (both null). Settings that can't be fingerprinted (the salt unreadable or invalid): broker null and
 * the error, never a silent null.
 */
function brokerFingerprint(env = process.env) {
  let b;
  try { b = activeBroker(env); } catch (_err) { return { broker: null, error: null, warning: null }; }
  // The allowlist names dropped as credential-like: said (the names only, never a value), never silently dropped.
  const dropped = fingerprintNames(b).refused.filter(n => CREDENTIAL.test(n));
  const warning = dropped.length ? `broker ${b.name}: fingerprintEnv ${dropped.join(', ')} look${dropped.length === 1 ? 's' : ''} like a credential: never recorded` : null;
  try {
    return { broker: fingerprintSettings(b, env), error: null, warning };
  } catch (err) {
    return { broker: null, error: `broker ${b.name}: its bar settings can't be fingerprinted (${err.message})`, warning };
  }
}

/**
 * The gate log read incrementally: each call reads only what was appended since the last (a file that
 * shrank, rotated or truncated, is read from its start), so a long-running session never rereads it.
 * Starts at the file's end: nothing logged before the reader existed is a refusal of its passes.
 */
function gateReader(file) {
  const size = () => { try { return fs.statSync(file).size; } catch (_err) { return 0; } };
  let offset = size();
  let partial = '';
  return {
    refusalsSince(ms) {
      const end = size();
      if (end < offset) { offset = 0; partial = ''; }
      if (end === offset) return [];
      const buf = Buffer.alloc(end - offset);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      offset = end;
      const lines = (partial + buf.toString('utf8')).split('\n');
      partial = lines.pop(); // a line still being written: read with the next call
      const out = [];
      for (const l of lines) {
        let e;
        try { e = JSON.parse(l); } catch (_err) { continue; }
        if (e && e.decision === 'blocked' && Date.parse(e.ts) >= ms) out.push(toRefusal(e));
      }
      return out;
    },
  };
}

/** Records a new version in the manifest when the hash or the fingerprints differ from the last; true when it did. */
function noteVersion(manifest, { since, hash, fingerprints: fp }) {
  const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
  const last = versions[versions.length - 1];
  if (last && last.hash === hash && JSON.stringify(last.fingerprints) === JSON.stringify(fp)) return false;
  manifest.versions = [...versions, { since, hash, fingerprints: fp }];
  manifest.fingerprints = fp;
  return true;
}

/** The version (of manifest.versions) that made the decision at t: the last one recorded since at or before it. */
function versionAt(manifest, t) {
  const ms = Date.parse(t);
  const list = Array.isArray(manifest.versions) ? manifest.versions : [];
  return list.filter(v => Date.parse(v.since) <= ms).pop() || list[0] || null;
}

module.exports = { failedRun, noDecision, passTap, fieldValues, decisionRecord, killSwitchReason, withEntry, fillsBetween, treeDigest, fingerprints, brokerFingerprint, noteVersion, versionAt, gateReader, HARNESS_DIRS, CODE_DIRS };
