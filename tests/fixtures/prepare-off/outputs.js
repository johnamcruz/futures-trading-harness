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
 *
 * Each pass's outputs: the prompt, the head trader's argv (the prompt elided) and child environment, the cycle record
 * (less its wall-clock fields and the prepare field), the cycle log's summary line, the runner's events and day-log
 * lines, and after the day the gate log, every state file in the home (less prepare/ and the shadow's session store)
 * and the decision record (the runner state's history), plus the run fingerprint (the validated runner config as the
 * run hashes it, and its HEAD_DELIVERY token list). normalize() names each world's home, the repo root, the runs'
 * random file names and the cycle ids alike, so two worlds compare byte for byte.
 */

const fs = require('fs');
const path = require('path');

const DAYS = ['no-fill', 'fill', 'manage-only'];
// A cycle record's fields that are wall-clock (when it was written, how long it took, its timing) or the shadow's own.
const WALL = new Set(['at', 'durationMs', 'timing', 'prepare']);
// Files of a home that are no state of the old path's: the shadow's own (prepare/: plans, session records, its gate
// log) and its CLI's session store; the live transcripts are removed by each run.
const NOT_STATE = /^(prepare|claude-sessions)(\/|$)/;

function normalizer(w, root) {
  const ids = new Map();
  const id = (kind, v) => { const k = `${kind}:${v}`; if (!ids.has(k)) ids.set(k, `<${kind}${ids.size}>`); return ids.get(k); };
  // The report cache's scope is a hash of the root's real path (report-cache.js scopeOf): another checkout, another hash.
  const scope = require(path.join(root, 'scripts', 'lib', 'trading', 'report-cache')).scopeOf(root);
  return text => String(text)
    .split(scope).join('<scope>')
    .split(w.home).join('<home>')
    .split(root).join('<root>')
    .replace(/cycle-transcript-\d+-[0-9a-f]+/g, m => id('transcript', m))
    .replace(/\b[0-9a-f]{16}\b/g, m => id('id', m))
    .replace(/"ts":"[^"]*"/g, '"ts":"<ts>"');
}

// The mock exchange's state as the old path left it: its book and every order call; its log of reads (an account read
// changes nothing at a broker) left out.
const ORDER_CALL = /^(place_order|modify_order|cancel_order|close_position|partial_close_position)$/;
const exchangeState = p => { const s = JSON.parse(fs.readFileSync(p, 'utf8')); return JSON.stringify({ ...s, calls: (s.calls || []).filter(c => ORDER_CALL.test(c.tool)) }); };

const readTree = (dir, base = dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? readTree(p, base) : [[path.relative(base, p), p]];
}) : []);

/**
 * One day: a fresh world (its runner config with `extra`), its three passes, `opts.runPrepare(w)` the shadow's runs
 * (none: the old path alone). Returns { passes, after } in normalized text, and the world.
 */
async function runDay(day, { extra = {}, runPrepare = null, before = null, cfgAt = null, beforePass = null } = {}) {
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
    const script = filled ? [{ result: 'CYCLE RESULT: managed - the open long' }] : D.passCycle(w, 'nothing to take');
    const r = await D.pass(w, D.decisionAt(bar), script, runPrepare ? { runPrepare: runPrepare(w) } : {});
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
  const state = readTree(w.home).filter(([rel]) => !NOT_STATE.test(rel) && !/^logs\/cycles\//.test(rel) && !/^logs\/cycles-.*\.jsonl$/.test(rel) && !/^logs\/toolcall\//.test(rel))
    .map(([rel, p]) => [rel, rel === 'exchange.json' ? exchangeState(p) : fs.readFileSync(p, 'utf8')]);
  const runnerState = JSON.parse(fs.readFileSync(w.stateFile, 'utf8'));
  const { validateConfig, headDeliveryOf } = require(path.join(ROOT, 'scripts', 'lib', 'autotrader'));
  const raw = { harness: 'claude', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], bars: 1400, ...(day === 'manage-only' ? { maxCyclesPerDay: 1 } : {}), ...extra };
  const cfg = validateConfig(raw);
  const out = {
    passes, records, lines, gate: fs.existsSync(w.env.FTH_GATE_LOG) ? fs.readFileSync(w.env.FTH_GATE_LOG, 'utf8') : '', state, history: runnerState.history,
    fingerprint: { cfg: { ...cfg, dataDir: null, workdir: null }, delivery: headDeliveryOf(null, cfg) },
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

/** The first difference between two outputs, as a path and the two values (null: equal). For a failing test's message. */
function firstDiff(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${at}/${k}`); if (d) return d; }
  }
  return { at, got: String(JSON.stringify(a)).slice(0, 400), want: String(JSON.stringify(b)).slice(0, 400) };
}

module.exports = { DAYS, runDay, allDays, firstDiff, normalizer };
