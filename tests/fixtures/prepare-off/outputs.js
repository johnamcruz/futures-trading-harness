'use strict';

/**
 * The old path's outputs on scripted replay days, normalized, for the prepare-ahead off regression
 * (tests/e2e/prepare-ahead-off-regression.test.js). The same code runs on origin/main to write the expected outputs
 * (main-outputs.json, by generate.js in a scratch checkout of main) and on the branch to compare, so the expected value is
 * main's, never the branch's own. Only what main has is used here (the decision-path world, the scripted model, the mock
 * exchange); a world's runner config takes `extra` keys (prepareAhead) and its pass the shadow's runs (`runPrepare`),
 * which main ignores.
 *
 * Days (the 04:06, 04:09 and 04:12 bars of tests/fixtures/decision-path.js, Claude Code's head trader passing each):
 *   no-fill      every cycle passes, flat all day
 *   fill         a position opens before the 04:12 pass (at the exchange): that cycle manages it
 *   manage-only  as fill, with the day's cap at one cycle: the 04:12 cycle is manage-only
 *   entry        at 04:09 the head trader sends its entry through the real gateway (decision-path.js entryCycle): the
 *                gate decides it (in this world it refuses it, [skills-loaded]: the gate log and the orders compare)
 *
 * Each pass's outputs: the prompt, the head trader's argv (the prompt elided) and child environment, the cycle record
 * (less its wall-clock fields and the prepare field), the cycle log's summary line, the runner's events and day-log
 * lines, and after the day the gate log, every state file in the home (the tool-call logs included; `own`: the files
 * a shadow wrote, left out only in shadow mode), the broker's whole call log (reads included: an extra read is a leak
 * against the live rate limits), the decision record (the runner state's history), plus the run fingerprint (the
 * validated runner config as the run hashes it, and its HEAD_DELIVERY token list). normalize() names each world's home,
 * the repo root, the report cache's scope, the runs' random transcript names and the cycle ids derived from them
 * (check-order.js cycleId), the gate log's time stamps and any wall-clock instant (within two days of the run) alike;
 * nothing else (any other value that changes shows).
 */

const fs = require('fs');
const path = require('path');

const DAYS = ['no-fill', 'fill', 'manage-only', 'entry'];
// The HOME the generator and the suite run under (they set it before the harness loads): the user's home is in the
// head trader's prompt and deny rules (os.homedir), so a fixed one keeps the fixture the same on every machine, and the
// normalizer names it too (belt and braces).
const PINNED_HOME = '/home/fth-off-regression';
// A cycle record's fields that are wall-clock (when it was written, how long it took, its timing) or the shadow's own.
const WALL = new Set(['at', 'durationMs', 'timing', 'prepare']);
// The files a shadow writes (its plans, session records and gate log under prepare/, its CLI's session store, its runs'
// tool-call logs): left out only in shadow mode (`own: SHADOW_OWN`); with the key off every file of the home compares.
const SHADOW_OWN = /^(prepare|claude-sessions|logs\/toolcall)(\/|$)/;

/**
 * Names each world's own values alike: the home, the repo root, the report cache's scope (a hash of the root's real path,
 * report-cache.js scopeOf), each run's random transcript file (in first-seen order) and the cycle id derived from it
 * (check-order.js cycleId: the same placeholder number), and the gate log's time stamps. What it can still hide: a run
 * whose transcript (and so its cycle id) is another run's in the same position, which is how runs are told apart anyway.
 */
function normalizer(w, root) {
  const ids = new Map();
  const id = v => { if (!ids.has(v)) ids.set(v, ids.size); return ids.get(v); };
  const scope = require(path.join(root, 'scripts', 'lib', 'trading', 'report-cache')).scopeOf(root);
  const crypto = require('crypto');
  const wall = Date.now();
  return text => {
    let s = String(text);
    // Each transcript path seen, and the cycle id the gate derives from it.
    const paths = [...new Set([...s.matchAll(/[^"\s]*cycle-transcript-\d+-[0-9a-f]+\.jsonl/g)].map(m => m[0]))];
    for (const p of paths) {
      const n = id(p.replace(/^.*\//, ''));
      const cyc = crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
      s = s.split(cyc).join(`<cycle${n}>`);
    }
    return s
      .split(scope).join('<scope>')
      .split(w.home).join('<home>')
      .split(root).join('<root>')
      // The machine's own: the user's home (os.homedir: the deny rules, the default harness home) and the node binary.
      .split(process.execPath).join('<node>')
      .split(require('os').homedir()).join('<user-home>')
      .replace(/cycle-transcript-\d+-[0-9a-f]+/g, m => `<transcript${id(m)}>`)
      .replace(/"ts":"[^"]*"/g, '"ts":"<ts>"')
      // A wall-clock time (a journal line's, a reply's): any instant within two days of the run's own wall clock (the
      // replayed day is months before it, so a replay time never reads as one).
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, t => (Math.abs(Date.parse(t) - wall) < 2 * 86400000 ? '<wall>' : t));
  };
}

// The mock exchange's state less its call log (the call log is its own output, `calls`, every call in order).
const exchangeState = p => { const s = JSON.parse(fs.readFileSync(p, 'utf8')); return JSON.stringify({ ...s, calls: undefined }); };
const exchangeCalls = p => (JSON.parse(fs.readFileSync(p, 'utf8')).calls || []).map(c => `${c.tool} ${JSON.stringify(c.args || {})}`);

// A directory's entries in code-unit order (never the platform's listing order, never the locale's collation).
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const readTree = (dir, base = dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).sort(byName).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? readTree(p, base) : [[path.relative(base, p), p]];
}) : []);

/**
 * Every state file of a world's home, [relative path, text] in code-unit order: the cycle records and lines are their
 * own outputs; `own` (a pattern) the files left out (the shadow's, in shadow mode); the exchange's state less its call
 * log (its own output).
 */
// A file's text; a gzip file's DECOMPRESSED text: its compressed bytes are the platform's (the header's OS byte, the
// zlib build and level), never the old path's output.
const textOf = p => (p.endsWith('.gz') ? require('zlib').gunzipSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8'));
function stateOf(w, own) {
  return readTree(w.home).filter(([rel]) => !(own && own.test(rel)) && !/^logs\/cycles\//.test(rel) && !/^logs\/cycles-.*\.jsonl$/.test(rel))
    .map(([rel, p]) => [rel.split(path.sep).join('/'), rel === 'exchange.json' ? exchangeState(p) : textOf(p)]);
}

/**
 * One day: a fresh world (its runner config with `extra`), its three passes, `opts.runPrepare(w)` the shadow's runs
 * (none: the old path alone). Returns { passes, after } in normalized text, and the world.
 */
async function runDay(day, { extra = {}, runPrepare = null, headRun = null, before = null, cfgAt = null, beforePass = null, own = null, fingerprint = true } = {}) {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const D = require(path.join(ROOT, 'tests', 'fixtures', 'decision-path'));
  const exchange = require(path.join(ROOT, 'tests', 'fixtures', 'mock-exchange'));
  const w = D.world({ harness: 'claude' });
  w.cfg = { ...w.cfg, ...(day === 'manage-only' ? { maxCyclesPerDay: 1 } : {}), ...extra };
  const base = w.cfg;
  const norm = normalizer(w, ROOT);
  if (before) before(w);
  const passes = [];
  for (const bar of [D.QUIET_BAR, D.FIRED_BAR, D.NEXT_BAR]) {
    // (The branch's own options: `cfgAt(bar)` the runner config's keys for that pass, as a restart with another config;
    // `beforePass(bar, w)` the test acting before it. main's generator uses neither.)
    if (cfgAt) w.cfg = { ...base, ...cfgAt(bar) };
    if (beforePass) beforePass(bar, w);
    const filled = day !== 'no-fill' && bar === D.NEXT_BAR;
    if (filled) exchange.handle(w.state, 'place_order', { accountId: 7, contractId: D.MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
    const script = filled ? [{ result: 'CYCLE RESULT: managed - the open long' }] : day === 'entry' && bar === D.FIRED_BAR ? D.entryCycle(w) : D.passCycle(w, 'nothing to take');
    // (`headRun(w, script)`: the branch's own: the head trader's runs played by another stand-in, prepare ahead "on".)
    // (Its last run's env stands for the scripted model's: the pass's env as main records it, for the normalizer too.)
    let headEnv = null;
    const hr = headRun ? headRun(w, script) : null;
    const r = await D.pass(w, D.decisionAt(bar), script, { ...(runPrepare ? { runPrepare: runPrepare(w) } : {}), ...(hr ? { headRun: (argv, o) => { headEnv = o.env; return hr(argv, o); } } : {}) });
    if (hr && headEnv) r.ctx = { env: headEnv };
    const env = r.ctx && r.ctx.env ? Object.fromEntries(Object.entries(r.ctx.env).filter(([k]) => /^(FTH_|CLAUDE_)/.test(k)).sort(([a], [b]) => a.localeCompare(b))) : null;
    passes.push({
      bar,
      ran: r.ran.map(x => ({ action: x.action, prompt: x.prompt, result: x.result, ok: x.ok, timedOut: x.timedOut })),
      env,
      logs: r.logs,
      events: r.events.map(({ ms: _ms, ...e }) => e),
    });
  }
  // The cycle records (less their wall-clock fields), the summary lines, the gate log, every state file, the history.
  const dir = path.join(w.home, 'logs', 'cycles');
  const records = readTree(dir).map(([rel, p]) => { const { argv, ...rec } = JSON.parse(fs.readFileSync(p, 'utf8')); return [rel, { ...Object.fromEntries(Object.entries(rec).filter(([k]) => !WALL.has(k))), argv }]; });
  const lines = fs.readdirSync(path.join(w.home, 'logs')).filter(f => /^cycles-.*\.jsonl$/.test(f)).sort().flatMap(f => fs.readFileSync(path.join(w.home, 'logs', f), 'utf8').trim().split('\n').map(l => { const { at: _a, durationMs: _d, timing: _t, promptChars: _p, ...x } = JSON.parse(l); return x; }));
  const state = stateOf(w, own);
  const runnerState = JSON.parse(fs.readFileSync(w.stateFile, 'utf8'));
  const { validateConfig, headDeliveryOf } = require(path.join(ROOT, 'scripts', 'lib', 'autotrader'));
  const raw = { harness: 'claude', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], bars: 1400, ...(day === 'manage-only' ? { maxCyclesPerDay: 1 } : {}), ...extra };
  // (`fingerprint: false`, the branch's own: a runner config the run drives directly but validateConfig would refuse,
  // prepare ahead "on" without headSkillsInPrompt, kept so its old path compares with main's; no fingerprint then.)
  const cfg = fingerprint ? validateConfig(raw) : null;
  const out = {
    passes, records, lines, gate: fs.existsSync(w.env.FTH_GATE_LOG) ? fs.readFileSync(w.env.FTH_GATE_LOG, 'utf8').trim().split('\n').filter(Boolean) : [], orders: exchange.read(w.state).calls.filter(c => c.tool === 'place_order').map(c => JSON.stringify(c.args)),
    calls: exchangeCalls(w.state), state, history: runnerState.history,
    fingerprint: cfg ? { cfg: { ...cfg, dataDir: null, workdir: null }, delivery: headDeliveryOf(null, cfg) } : null,
  };
  return { w, out: compact(JSON.parse(norm(JSON.stringify(out)))) };
}

// A long text (a prompt, a transcript, a state file) is kept as its digest, so the fixture stays small; a difference in
// it still shows (its path names where).
const LONG = 300;
const compact = v => (typeof v === 'string' ? (v.length > LONG ? `sha256:${require('crypto').createHash('sha256').update(v).digest('hex')} (${v.length} chars)` : v)
  : Array.isArray(v) ? v.map(compact) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)])) : v);

/** Every day's outputs: { day: out }. */
async function allDays(opts = {}) {
  const res = {};
  for (const day of DAYS) res[day] = (await runDay(day, typeof opts === 'function' ? opts(day) : opts)).out;
  return res;
}

/** Every difference between two outputs, in path order, at most `cap` (50): [{ at, got, want }]. */
function allDiffs(a, b, at = '', out = [], cap = 50) {
  if (out.length >= cap || JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { allDiffs(a[k], b[k], `${at}/${k}`, out, cap); if (out.length >= cap) break; }
    return out;
  }
  out.push({ at, got: String(JSON.stringify(a)).slice(0, 400), want: String(JSON.stringify(b)).slice(0, 400) });
  return out;
}

/** The first difference between two outputs, as a path and the two values (null: equal). For a failing test's message. */
function firstDiff(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${at}/${k}`); if (d) return d; }
  }
  return { at, got: String(JSON.stringify(a)).slice(0, 400), want: String(JSON.stringify(b)).slice(0, 400) };
}

module.exports = { DAYS, PINNED_HOME, SHADOW_OWN, stateOf, allDiffs, runDay, allDays, firstDiff, normalizer };
