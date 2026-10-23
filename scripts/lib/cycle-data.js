'use strict';

/**
 * The head trader's cycle data, pre-collected: this machine's opt-in (the runner config's cycleDataInPrompt, Claude
 * Code only: autotrader.js validateConfig). The reads a head trader makes first every cycle (its bar briefing for each
 * symbol, then the account: get_account_snapshot, list_open_positions, list_open_orders) are made by the runner just
 * before the head trader's run (cycle-run.js runCycle), each through the path the model's own call takes, and put in
 * its prompt as their exact text, at the end (before the result line: autotrader.js withCycleData), so the prefix the
 * prompt cache reuses stays the same. The model gets the same information it would read itself; only the delivery
 * changes. With the key absent nothing here runs.
 *
 * Exact text, never a summary:
 *   bar_briefing   the harness tool itself (harness-tools/protocol.js callTool, the function the harness MCP server
 *                  runs), with the head trader's own run's environment (autotrader.js childEnv: its cycle bar, its
 *                  replay clock), so it renders this cycle's briefing as of its bar's close, stable all cycle;
 *   broker reads   the broker adapter's readText (broker/adapter.js): straight to the server through the contract
 *                  translator, the raw reply text, as the gateway passes the model's reads through unchanged.
 * A read not made whole (an error reply, no single text item, a briefing that isn't this cycle's bar's, a clock that
 * refuses, a broker client that reads no raw text, a throw) gives no block: a plain line names it and tells the model
 * to read it itself. Nothing is retried, nothing guessed.
 *
 * The blocks are data, as tool results are: nothing reads them back. No gate or check parses them (the order gate,
 * compose_check and the cycle checks recompute from the harness home's own state, never from the prompt), so a block
 * can't count for anything, and nothing trusts its header or footer: the footer's sha256 is a record of the text given
 * (the cycle log's), never a check. The cycle log records what was given (records: tool, args, asOf, sha256, chars; and
 * what wasn't).
 *
 * Paper mode (the runner config's paper): no broker read is collected (the runner's own broker client doesn't run under
 * the broker's paper settings the head trader's gateway does), each one a "read it yourself" line. The whole section
 * stays under config/runner.json prompt.cycleDataMaxBytes (capped: the largest blocks give way to their lines first).
 *
 * The cycle's store (createStore): every read is made once a cycle, keyed by its tool and its arguments (canonical), and
 * kept as { tool, args, asOf, text, sha256, ok } (or { ok: false, why }); everyone in the cycle who needs a read takes it
 * from there: the runner's desk (each desk role's every-cycle reads: deskReads, collectDesk; the same bar_briefing once
 * for every analyst) and then the head trader (collect, with the store). The store lives in the runner's memory, one
 * per cycle, written only by the runner: no session can write it, and no tool serves from it (a tool the model calls
 * makes its own read, as without the key). It holds the reads of one environment (cycleOf: every variable but each
 * run's own, PER_RUN): a reader whose environment differs, as a run of another cycle's does, never takes from it, and
 * reads its own instead. A read that changes with fills or the market (VOLATILE: the account, its positions and
 * orders, a quote) is read again for each later reader (the head trader after the desk), never handed on stale.
 *
 *   on(cfg)                     the key is on (harness claude, cycleDataInPrompt true)
 *   READS                       the head trader's broker reads collected, in prompt order
 *   createStore({ root, broker, now, callTool, paper })   the cycle's store: fill(reads, { env, refresh }) ->
 *                               [entry] in the reads' order (each key read once; null when `env` is not the store's
 *                               cycle's), preload(reads, { env }) (the `preload` reads only, before the close: the
 *                               seam for a later preloader; none is built), made (reads made so far), cycle (its
 *                               environment's fingerprint)
 *   kindOf(tool)                'preload' (independent of the closing bar, the clock, the account and the journal) or 'close'
 *   deskReads(role, { symbol, contractId, accountId })   [{ tool, args }] a desk role reads every cycle (its agent body)
 *   collectDesk({ roles, symbol, contractId, accountId, env, store })   { [role]: { blocks, missing, primaryOk } }
 *   deskFailed(roles, why)      a desk collection that failed as a whole: no block for any role
 *   briefingServed(env, symbol) { briefing, digest } when bar_briefing serves this cycle's bar's briefing, else { why }
 *   collect({ symbols, accountId, env, root, broker, now, callTool, paper, store })   { blocks: [{ tool, args, asOf, text }], missing: [{ tool, args, why }] }
 *   capped(collected, maxBytes) the same, the largest blocks dropped (each a missing read) until the section fits
 *   render({ blocks, missing }, { intro })   the prompt's data section ('' when there is nothing to say); `intro` a
 *                               desk role's (DESK_INTRO, analystIntro), the head trader's by default
 *   records({ blocks })         [{ tool, args, asOf, sha256, chars }] for the cycle log
 *   failed(why)                 a collection that threw as a whole: no block, one line
 *   skipped(why)                no collection at all (too little time left): no block, one line
 */

const crypto = require('crypto');
const { harnessHome } = require('./paths');
const { readBriefing } = require('./trading/briefing');
const { cycleBarOf } = require('./harness-tools/briefing');
const { briefingAfterClock } = require('./trading/look-ahead');
const { replayAt } = require('./trading/harness-now');

const REASON_CHARS = require('./tunables').runner().prompt.reasonChars; // config/runner.json prompt.reasonChars
const MAX_BYTES = require('./tunables').runner().prompt.cycleDataMaxBytes; // config/runner.json prompt.cycleDataMaxBytes
const READS = Object.freeze(['get_account_snapshot', 'list_open_positions', 'list_open_orders']);
const BRIEFING = 'bar_briefing';
// The harness tools among the reads (harness-tools/protocol.js callTool); every other read is the broker's (readText).
const HARNESS_READS = Object.freeze([BRIEFING, 'strategies_list', 'combine_status']);
// Broker reads that change with fills or the market within a cycle: read again for each later reader, never handed on.
const VOLATILE = Object.freeze([...READS, 'get_quote']);
// The variables childEnv sets for each run of a cycle on its own (its transcript, its role, its records): not the reads'.
const PER_RUN = Object.freeze(['FTH_CYCLE_TRANSCRIPT', 'FTH_ROLE_RUN', 'FTH_ROLE_SKILLS', 'FTH_HEAD_PROMPT', 'FTH_CYCLE_ROLES', 'FTH_CYCLE_DESK', 'FTH_CYCLE_CACHED', 'FTH_CYCLE_CACHED_LOOKUPS', 'FTH_CYCLE_ENTRY', 'FTH_CYCLE_MANAGE', 'FTH_CYCLE_ID']);
const RISK_MANAGER = 'risk-manager';
// Each read's kind: `preload` when its answer doesn't depend on the bar about to close nor on the clock, the account
// or the journal (the strategies registered: their files), so a later preloader may make it between cycles (preload);
// `close` for every other (the bar's briefing; the attempts and the quote, which move with the clock; the server's
// config, which carries the server's time; the accounts, the account's reads and the journal, which move with fills
// and entries): made only at the bar's close, in the cycle (fill). The account's and the journal's reads stay `close`
// for now: preloading them needs a re-read at close after any fill or order event, which nothing here can see yet.
const PRELOAD = Object.freeze(['strategies_list']);
const kindOf = tool => (PRELOAD.includes(tool) ? 'preload' : 'close');

const on = cfg => Boolean(cfg) && cfg.harness === 'claude' && cfg.cycleDataInPrompt === true;
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
// A reason, as the prompt shows one: its first line, at most config/runner.json prompt.reasonChars.
const short = t => String(t || '').split('\n')[0].slice(0, REASON_CHARS);
const errText = err => short((err && err.message) || err);
const argsText = args => JSON.stringify(args);
// Arguments with their keys in order, nested too: one key for one read however its arguments were written.
const canonical = v => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v);
const keyOf = (tool, args) => `${tool} ${JSON.stringify(canonical(args || {}))}`;
/** The fingerprint of the environment the reads are made in: every variable but each run's own (PER_RUN). */
const cycleOf = env => sha256(JSON.stringify(Object.keys(env || {}).filter(k => !PER_RUN.includes(k)).sort().map(k => [k, env[k]])));

/** Whether bar_briefing serves this cycle's bar's briefing for `symbol`'s root under `env` (harness-tools/briefing.js barBriefing). */
function briefingServed(env, symbol) {
  const root = /^([A-Z0-9]{1,8})(?::\d{4}-\d{2})?$/.exec(String(symbol || ''));
  if (!root) return { why: `${short(symbol)} is not a contract root` };
  const b = readBriefing(harnessHome(env), root[1]);
  if (!b) return { why: 'no bar briefing' };
  // The bar the cycle decides (several lanes: the first lane's, which its briefing is on), as bar_briefing tests it.
  const bar = cycleBarOf(env, root[1], 'FTH_CYCLE_BRIEFING_BARS') || cycleBarOf(env, root[1]);
  if (!bar) return { why: 'no cycle bar for it' };
  if (b.asOf !== bar) return { why: `the briefing is of the bar opened ${b.asOf}, not this cycle's (${bar})` };
  let later;
  try { later = briefingAfterClock(b, replayAt(env)); } catch (err) { return { why: `the clock refused (${errText(err)})` }; }
  if (later) return { why: later };
  return { briefing: b, digest: sha256(JSON.stringify(b)) };
}

/** The one text of an MCP tool result, or null (not exactly one text item). */
function onlyText(res) {
  const c = res && Array.isArray(res.content) ? res.content : [];
  return c.length === 1 && c[0] && c[0].type === 'text' && typeof c[0].text === 'string' ? c[0].text : null;
}

async function briefingRead(args, { env, root, callTool }) {
  const { symbol } = args;
  const before = briefingServed(env, symbol);
  if (!before.briefing) return { tool: BRIEFING, args, why: before.why };
  const res = await callTool(BRIEFING, args, { env, root });
  const text = onlyText(res);
  if (res && res.isError) return { tool: BRIEFING, args, why: `the tool refused (${short(text)})` };
  if (text === null) return { tool: BRIEFING, args, why: 'the reply is not one text' };
  // The briefing it rendered is the one checked: the same bar's, unchanged while it was read.
  const after = briefingServed(env, symbol);
  if (!after.briefing || after.digest !== before.digest) return { tool: BRIEFING, args, why: 'the briefing changed while it was read' };
  return { tool: BRIEFING, args, asOf: before.briefing.closedAt, text };
}

async function brokerRead(tool, args, { broker, now }) {
  if (!broker || typeof broker.readText !== 'function') return { tool, args, why: 'the runner\'s broker client reads no raw text' };
  const asOf = now().toISOString();
  const res = await broker.readText(tool, args);
  if (!res || res.isError) return { tool, args, why: `the broker answered with an error (${short(res && res.text)})` };
  if (typeof res.text !== 'string') return { tool, args, why: 'the reply is not one text' };
  return { tool, args, asOf, text: res.text };
}

async function harnessRead(tool, args, { env, root, callTool, now }) {
  const asOf = now().toISOString();
  const res = await callTool(tool, args, { env, root });
  const text = onlyText(res);
  if (res && res.isError) return { tool, args, why: `the tool refused (${short(text)})` };
  if (text === null) return { tool, args, why: 'the reply is not one text' };
  return { tool, args, asOf, text };
}

/** One read, made whole or not (`why`); never throws. Paper mode: no broker read (the runner's client isn't under it). */
function readOne({ tool, args }, o) {
  const safe = p => p.catch(err => ({ tool, args, why: `the read failed (${errText(err)})` }));
  if (tool === BRIEFING) return safe(Promise.resolve().then(() => briefingRead(args, o)));
  if (HARNESS_READS.includes(tool)) return safe(Promise.resolve().then(() => harnessRead(tool, args, o)));
  if (o.paper) return Promise.resolve({ tool, args, why: READS.includes(tool) ? 'paper mode: the runner reads no account for you' : 'paper mode: the runner makes no broker read for you' });
  return safe(Promise.resolve().then(() => brokerRead(tool, args, o)));
}

/** A read as the store keeps it: its text's sha256, and ok (made whole). */
const entryOf = r => (typeof r.text === 'string' ? { tool: r.tool, args: r.args, kind: kindOf(r.tool), asOf: r.asOf, text: r.text, sha256: sha256(r.text), ok: true } : { tool: r.tool, args: r.args, kind: kindOf(r.tool), ok: false, why: r.why });

/**
 * The cycle's store (the runner's, in memory, one per cycle). The first fill fixes its environment (cycleOf); a fill in
 * another one is refused (null), so a reader of another cycle never takes from it. Each key is read once; a key in
 * `refresh` (tool names) is read again when an earlier fill read it (a later reader gets it fresh).
 * preload(reads, { env }): the seam a later preloader calls between cycles, before the bar closes: it makes only the
 * `preload` reads (kindOf) and fixes no cycle; a `close` read is never made there (look-ahead: replay equals live), and
 * comes back { ok: false, why }. The cycle's fill takes a preloaded entry as made.
 */
function createStore({ root, broker = null, now = () => new Date(), callTool = require('./harness-tools/protocol').callTool, paper = false } = {}) {
  const entries = new Map(); // key -> { fill, p: Promise<entry> }
  let cycle = null;
  let env0 = null;
  let fills = 0;
  let made = 0;
  return {
    get cycle() { return cycle; },
    get made() { return made; },
    matches: env => cycle === null || cycle === cycleOf(env),
    fill(reads, { env, refresh = [] } = {}) {
      if (cycle === null) { cycle = cycleOf(env); env0 = env; } else if (cycle !== cycleOf(env)) return null;
      fills += 1;
      return Promise.all(reads.map(r => {
        const k = keyOf(r.tool, r.args);
        const had = entries.get(k);
        if (!had || (refresh.includes(r.tool) && had.fill < fills)) {
          made += 1;
          entries.set(k, { fill: fills, p: readOne(r, { env: env0, root, broker, now, callTool, paper }).then(entryOf) });
        }
        return entries.get(k).p;
      }));
    },
    preload(reads, { env } = {}) {
      return Promise.all(reads.map(r => {
        if (kindOf(r.tool) !== 'preload') return Promise.resolve({ tool: r.tool, args: r.args, kind: 'close', ok: false, why: 'a read of the closing bar: made only at its close' });
        const k = keyOf(r.tool, r.args);
        if (!entries.has(k)) {
          made += 1;
          entries.set(k, { fill: fills, p: readOne(r, { env, root, broker, now, callTool, paper }).then(entryOf) });
        }
        return entries.get(k).p;
      }));
    },
  };
}

/** An entry as a prompt block ({ tool, args, asOf, text }) or a missing read ({ tool, args, why }). */
const asBlock = e => ({ tool: e.tool, args: e.args, asOf: e.asOf, text: e.text });
const asMissing = e => ({ tool: e.tool, args: e.args, why: e.why });

/**
 * Every read, in prompt order: each symbol's bar briefing, then the account's reads (none without an account). `env`:
 * the head trader's run's environment. A read that throws is a missing one; collect itself never throws.
 */
async function collect({ symbols = [], accountId = null, env, root, broker = null, now = () => new Date(), callTool = require('./harness-tools/protocol').callTool, paper = false, store = null }) {
  const reads = [...new Set(symbols.filter(Boolean))].map(symbol => ({ tool: BRIEFING, args: { symbol } }));
  if (Number.isInteger(accountId) && accountId >= 1) for (const tool of READS) reads.push({ tool, args: { accountId } });
  // The cycle's store when it is this environment's (the desk's reads taken, the account's read again); else a store of
  // its own (a store of another cycle is never read).
  const own = store && store.matches(env) ? store : createStore({ root, broker, now, callTool, paper });
  let done;
  try { done = await own.fill(reads, { env, refresh: VOLATILE }); } catch (err) { done = reads.map(r => ({ ...r, ok: false, why: `the read failed (${errText(err)})` })); }
  return { blocks: done.filter(e => e.ok).map(asBlock), missing: done.filter(e => !e.ok).map(asMissing) };
}

const INTRO = 'This cycle\'s reads, already made: the runner called these tools for you just before your run, with your own tools\' settings, and each block below holds exactly the text the tool returned (its arguments and as-of time in its header). Take them as your own reads of those tools; call a tool again only for anything more, or for anything newer than its as-of time.';
const header = b => `--- ${b.tool} ${argsText(b.args)} as of ${b.asOf} ---`;
const footer = b => `--- end of ${b.tool} ${argsText(b.args)} (sha256 ${sha256(b.text)}) ---`;

// A desk role's: the same blocks, made before the desk ran with this cycle's settings for its tools.
const DESK_INTRO = 'This cycle\'s reads, already made: the runner called these tools for you before the desk ran, with this cycle\'s settings for your tools, and each block below holds exactly the text the tool returned (its arguments and as-of time in its header). Take them as your own reads of those tools; call a tool again only for anything more, or for anything newer than its as-of time.';
// An analyst's adds its Data line: a block it rests on is named as its own read, so the report cache reads its versions.
const ANALYST_DATA = ' Name a block you rest on in your Data line as your own read: `Data: bar_briefing <the versions you used>`.';
const introOf = role => (role === RISK_MANAGER ? DESK_INTRO : `${DESK_INTRO}${ANALYST_DATA}`);

/** The prompt's data section: the blocks, then a line for each read not made ('' with neither). */
function render({ blocks = [], missing = [], note = null } = {}, { intro = INTRO } = {}) {
  if (!blocks.length && !missing.length && !note) return '';
  const lines = [`\n=== ${intro} ===`];
  for (const b of blocks) lines.push(header(b), b.text, footer(b));
  for (const m of missing) lines.push(`Not collected: ${m.tool} ${argsText(m.args)} (${m.why}); read it yourself if you need it.`);
  if (note) lines.push(note);
  lines.push('=== end of this cycle\'s reads ===\n');
  return lines.join('\n');
}

/** What the cycle log records of the blocks given. */
const records = ({ blocks = [] } = {}) => blocks.map(b => ({ tool: b.tool, args: b.args, asOf: b.asOf, sha256: sha256(b.text), chars: b.text.length }));

/**
 * The collection with its section under `maxBytes` (UTF-8, as the prompt goes out: well under one argv string's limit):
 * the largest block dropped first, each one a missing read, until the rendered section fits.
 */
function capped(got, maxBytes = MAX_BYTES, opts = {}) {
  let blocks = [...(got.blocks || [])];
  const missing = [...(got.missing || [])];
  while (blocks.length && Buffer.byteLength(render({ ...got, blocks, missing }, opts)) > maxBytes) {
    const big = blocks.reduce((a, b) => (Buffer.byteLength(b.text) > Buffer.byteLength(a.text) ? b : a));
    blocks = blocks.filter(b => b !== big);
    missing.push({ tool: big.tool, args: big.args, why: `its ${Buffer.byteLength(big.text)} bytes would take this cycle's reads past ${maxBytes} (config/runner.json prompt.cycleDataMaxBytes)` });
  }
  return { ...got, blocks, missing };
}

/** No collection at all (too little of the cycle's time left): no block, one line saying so. */
const skipped = why => ({ blocks: [], missing: [], note: `The runner made no reads for this cycle (${errText(why)}): make your reads yourself.` });

/** A collection that threw as a whole: no block, one line saying so. */
const failed = why => ({ blocks: [], missing: [], note: `The runner's reads for this cycle could not be made (${errText(why)}): make your reads yourself.` });

/**
 * What a desk role reads first every cycle, as its agent body says (agents/*.md), with its arguments as written there:
 * every analyst its bar briefing (`bar_briefing {"symbol"}`); market structure the live strategies (`strategies_list`),
 * volume and liquidity the live quote (`get_quote`, once); risk-manager phase 1 its steps 1 to 5 (the server's config,
 * the accounts, the account's snapshot, today's reviews and recent lessons, the attempts). An analyst on its own
 * timeframe reads the runner's briefing too (its session facts), so that read is the same for it.
 */
function deskReads(role, { symbol, contractId = null, accountId = null }) {
  const brief = { tool: BRIEFING, args: { symbol } };
  if (role === 'market-structure-analyst') return [brief, { tool: 'strategies_list', args: {} }];
  if (role === 'trend-momentum-analyst') return [brief];
  if (role === 'volume-liquidity-analyst') return [brief, { tool: 'get_quote', args: { contractId: contractId || symbol } }];
  if (role === RISK_MANAGER) {
    const account = Number.isInteger(accountId) && accountId >= 1 ? [{ tool: 'get_account_snapshot', args: { accountId } }] : [];
    return [{ tool: 'get_server_config', args: {} }, { tool: 'list_accounts', args: {} }, ...account, { tool: 'journal_read', args: { kind: 'review' } }, { tool: 'journal_read', args: { kind: 'lesson' } }, { tool: 'combine_status', args: {} }];
  }
  return [];
}

/** The read a role's credit rests on (checks.js read-data): an analyst's bar briefing, phase 1's account snapshot. */
const primaryOf = (role, { symbol, accountId = null }) => (role === RISK_MANAGER ? (Number.isInteger(accountId) && accountId >= 1 ? keyOf('get_account_snapshot', { accountId }) : null) : keyOf(BRIEFING, { symbol }));

/**
 * The desk's reads, made once in the cycle's store (a read several roles share made once), then each role's: its blocks
 * (capped as the head trader's, the largest giving way first), its missing reads, and `primaryOk`: its primary read
 * (primaryOf) made whole and in its blocks: a bar briefing served as this cycle's, an account snapshot answered as one
 * text with no error. Phase 1 without an account in the runner config: no snapshot, a line, no credit.
 */
async function collectDesk({ roles, symbol, contractId = null, accountId = null, env, store, maxBytes = MAX_BYTES }) {
  const per = Object.fromEntries(roles.map(role => [role, deskReads(role, { symbol, contractId, accountId })]));
  const all = Object.values(per).flat();
  const done = store ? await store.fill(all, { env }) : null;
  if (!done) return deskFailed(roles, 'the cycle\'s store is another cycle\'s');
  const byKey = new Map(all.map((r, i) => [keyOf(r.tool, r.args), done[i]]));
  const out = {};
  for (const role of roles) {
    const entries = per[role].map(r => byKey.get(keyOf(r.tool, r.args)));
    const noAccount = role === RISK_MANAGER && !primaryOf(role, { symbol, accountId }) ? [{ tool: 'get_account_snapshot', args: {}, why: 'no account in the runner config' }] : [];
    const got = capped({ blocks: entries.filter(e => e.ok).map(asBlock), missing: [...entries.filter(e => !e.ok).map(asMissing), ...noAccount] }, maxBytes, { intro: introOf(role) });
    const primary = primaryOf(role, { symbol, accountId });
    const primaryOk = Boolean(primary) && got.blocks.some(b => keyOf(b.tool, b.args) === primary);
    out[role] = Object.freeze({ blocks: got.blocks, missing: got.missing, primaryOk });
  }
  return Object.freeze(out);
}

/** A desk collection that failed as a whole: every role a line and no credit. */
const deskFailed = (roles, why) => Object.freeze(Object.fromEntries(roles.map(role => [role, Object.freeze({ blocks: [], missing: [], note: `The runner's reads for this cycle could not be made (${errText(why)}): make your reads yourself.`, primaryOk: false })])));

/** A desk role's data section in its request ('' without a record for it). */
const deskText = (role, rec) => (rec ? render(rec, { intro: introOf(role) }) : '');

module.exports = { READS, BRIEFING, INTRO, DESK_INTRO, MAX_BYTES, VOLATILE, PER_RUN, PRELOAD, kindOf, on, sha256, keyOf, cycleOf, briefingServed, onlyText, createStore, collect, deskReads, collectDesk, deskFailed, deskText, capped, render, records, failed, skipped };
