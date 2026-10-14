'use strict';

/**
 * The harness-tools MCP server's tools (server name `harness`): one per
 * operation in index.js OPERATIONS, each with a JSON Schema for its arguments
 * (validate.js; `additionalProperties: false`, so an unknown argument is
 * refused) and the mapping from those arguments to the operation's own.
 *
 * What a tool never takes: an environment, a working directory, an output
 * path, a time (the server's clock decides: trading/harness-now.js), or any
 * free-form path but a bars file (`bars`, `daily`: checked by paths.js before
 * the operation runs). Nothing here places, modifies, or cancels an order.
 *
 * Each TOOLS entry: { name, op, script, description, inputSchema, args(input),
 * bars: [argument names that are bars files], clockFirst (read the harness
 * clock before running, as the CLI does), envFile (load the user's .env, as the
 * CLI does), narrow (how to make the output smaller) }.
 */

const { MAX_COUNT } = require('../bars-fetch');
const { PARAMS } = require('../trading/market-snapshot');

const SERVER_NAME = 'harness';
const SYMBOL = { type: 'string', pattern: '^[A-Z0-9]{1,8}$', description: 'A contract root, upper case (e.g. MNQ, MES).' };
const BARS = { type: 'string', minLength: 1, maxLength: 1024, description: 'A bars file by absolute path (.json or .csv, at most 50 MB) under the bars directory (FTH_BARS_DIR, default <FTH_HOME>/bars) or <FTH_HOME>/bars-scratch (where bars_fetch writes).' };
const JSON_FLAG = { type: 'boolean', description: 'The full result as JSON instead of text.' };
const RECORD = { type: 'boolean', description: 'Also record the result for the order gate (ignored in autonomous runs, where the reply notes it, and refused while the autonomous runner runs: it records them).' };
const ISO = { type: 'string', maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})$' };

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pick = (input, map) => Object.fromEntries(Object.entries(map).filter(([k]) => input[k] !== undefined).map(([k, to]) => [to, input[k]]));

const TOOLS = [
  {
    name: 'strategies_list', op: 'strategies_list', script: 'strategies',
    description: 'List the registered strategies: name, status, signal type, instruments, description. json: every field (timeframe, sessions, file) as JSON on one line.',
    inputSchema: object({ json: { type: 'boolean', description: 'Every field as JSON (on one line) instead of text.' } }),
    args: i => ({ ...pick(i, { json: 'json' }), compact: true }),
    narrow: 'call it without json',
  },
  {
    name: 'strategies_show', op: 'strategies_show', script: 'strategies',
    description: 'Show one registered strategy\'s STRATEGY.md, by its registered name (strategies_list).',
    inputSchema: object({ name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', description: 'A registered strategy name, e.g. orb.' } }, ['name']),
    args: i => ({ name: i.name }),
    narrow: 'the strategy document is too large to return',
  },
  {
    name: 'strategies_validate', op: 'strategies_validate', script: 'strategies',
    description: 'Validate every STRATEGY.md against the schema; an error result lists what is invalid.',
    inputSchema: object(),
    args: () => ({}),
    narrow: 'fix the invalid strategies first',
  },
  {
    name: 'strategies_scan', op: 'strategies_scan', script: 'strategies',
    description: 'Scan the strategies on a bars file at the harness clock: which setups are candidates on the last closed bar, of the strategies on the bars\' timeframe only (a 1m strategy is not scanned on 3m bars; name on one is refused). Returns a summary: the candidates first (side, entry reference, the stop and target in points and in ticks with a contract\'s dollars, min R:R, exit, confluence; order_plan gives the order itself), then one line per strategy (name, status, timeframe, direction, candidate, why not). name: that strategy\'s full result as JSON; detail: every strategy\'s full result as JSON (large). record also records the fired rules strategies for the order gate\'s trigger check.',
    inputSchema: object({
      bars: BARS, symbol: SYMBOL, record: RECORD,
      name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', description: 'One strategy: its full scan result as JSON (rules with ok, detail, mtf, exit).' },
      detail: { type: 'boolean', description: 'Every strategy\'s full scan result as JSON (large: prefer name).' },
    }, ['bars', 'symbol']),
    args: i => ({ ...pick(i, { bars: 'file', symbol: 'symbol', name: 'name' }), record: i.record === true, view: i.name ? 'one' : i.detail === true ? 'json' : 'summary' }),
    bars: ['bars'],
    narrow: 'call it without detail (the summary), or with name for one strategy',
  },
  {
    name: 'strategies_recent', op: 'strategies_recent', script: 'strategies',
    description: 'What each strategy fired on each of the last closed bars of a bars file: one line per bar (its open time, then each strategy and side that fired, or none). json: the same as JSON.',
    inputSchema: object({ bars: BARS, symbol: SYMBOL, count: { type: 'integer', minimum: 1, maximum: 50, description: 'How many of the last bars (default 5).' }, json: JSON_FLAG }, ['bars', 'symbol']),
    args: i => ({ ...pick(i, { bars: 'file', symbol: 'symbol', count: 'count' }), format: i.json === true ? 'json' : 'lines' }),
    bars: ['bars'],
    narrow: 'lower count, or call it without json',
  },
  {
    name: 'order_plan', op: 'order_plan', script: 'strategies',
    description: 'A calculator for the order arithmetic of a trade you chose (strategy and side are yours, from the skills and STRATEGY.md; it never picks, ranks, or advises): for a strategy that is a candidate on the last closed bar of a bars file (at the harness clock), or a policy strategy\'s live verdict, it shows its working (entry reference, the stop and target in points and whole ticks, prices on the tick with the stop below a long\'s entry and above a short\'s, how the size was derived, $ risk) and gives the exact place_order arguments as JSON, with the rationale tag the order gate reads. It never places an order. Refused, with the reason, when the strategy is not a candidate now, its rules did not fire on that side, or the bars are not on its timeframe or are older than the gate\'s signal age.',
    inputSchema: object({
      bars: BARS, symbol: SYMBOL,
      strategy: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', description: 'The strategy you chose, by its registered name (a scan candidate, or a policy strategy for its verdict).' },
      side: { type: 'string', enum: ['long', 'short'], description: 'The side you chose (refused when the strategy\'s rules did not fire on it).' },
      accountId: { type: 'integer', minimum: 1, description: 'The broker account\'s id, put into the place_order arguments.' },
    }, ['bars', 'symbol', 'strategy', 'side']),
    args: i => pick(i, { bars: 'file', symbol: 'symbol', strategy: 'strategy', side: 'side', accountId: 'accountId' }),
    bars: ['bars'],
    narrow: 'the reply is too large to return',
  },
  {
    name: 'market_snapshot', op: 'market_snapshot', script: 'market-snapshot',
    description: 'The indicator and level snapshot of a bars file (closed bars, oldest first) as JSON on one line. params overrides the default indicator settings.',
    inputSchema: object({
      bars: BARS,
      params: { type: 'object', properties: Object.fromEntries(Object.entries(PARAMS).map(([k, d]) => [k, { type: 'number', description: `default ${d}` }])), additionalProperties: false, description: 'Indicator settings to override (known names only, numbers).' },
      symbol: { ...SYMBOL, description: `${SYMBOL.description} The volume profile's levels come on its tick. Default: the root the harness's bars file is named for (MNQ-3m.json); two decimals without either.` },
    }, ['bars']),
    args: i => ({ ...pick(i, { bars: 'file', symbol: 'symbol' }), params: i.params || {}, compact: true }),
    bars: ['bars'],
    narrow: 'pass a bars file with fewer bars, or smaller vpRows',
  },
  {
    name: 'mtf_read', op: 'mtf', script: 'mtf',
    description: 'The multi-timeframe read of trigger bars: the trend on each higher timeframe and whether a long or a short is aligned, a pullback, or counter. record (with symbol) also records it for the order gate.',
    inputSchema: object({
      bars: BARS,
      timeframes: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 1440 }, minItems: 1, maxItems: 6, description: 'Higher timeframes in minutes (default [15, 60, 240]).' },
      daily: { ...BARS, description: `A daily bars file, the top timeframe. ${BARS.description}` },
      json: JSON_FLAG, record: RECORD, symbol: SYMBOL,
    }, ['bars']),
    args: i => ({ ...pick(i, { bars: 'file', timeframes: 'tf', daily: 'daily', symbol: 'symbol' }), json: i.json === true, record: i.record === true }),
    bars: ['bars', 'daily'],
    narrow: 'call it without json',
  },
  {
    name: 'blackouts_list', op: 'blackouts_list', script: 'blackouts',
    description: 'The news blackout windows the order gate enforces.',
    inputSchema: object(),
    args: () => ({}),
    clockFirst: true,
    narrow: 'the list is too large to return',
  },
  {
    name: 'blackouts_add', op: 'blackouts_add', script: 'blackouts',
    description: 'Add a news blackout window for the order gate (append-only: it only ever restricts trading). At most 12 hours, not yet ended.',
    inputSchema: object({
      start: { ...ISO, description: 'Start, ISO 8601 with a zone (e.g. 2026-10-07T12:25:00Z).' },
      end: { ...ISO, description: 'End, ISO 8601 with a zone, after start.' },
      reason: { type: 'string', minLength: 1, maxLength: 120, description: 'Why (e.g. CPI 08:30 ET).' },
    }, ['start', 'end', 'reason']),
    args: i => ({ start: i.start, end: i.end, reason: i.reason }),
    clockFirst: true,
    narrow: 'the reply is too large to return',
  },
  {
    name: 'bars_fetch', op: 'bars_fetch', script: 'bars',
    description: `Fetch closed bars for a symbol from the broker into <FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json (this harness home's own scratch directory) (or -1d.json; with name, <SYMBOL>-<tf>m-<name>.json, a file of the caller's own that no other fetch replaces) at the harness clock, for the other tools' bars argument. Returns one line: the file, the contract, the bar count, when the last bar closed. record also records the multi-timeframe read for the order gate (not for daily bars).`,
    inputSchema: object({
      symbol: SYMBOL,
      timeframe: { anyOf: [{ type: 'integer', minimum: 1, maximum: 60 }, { type: 'string', enum: ['daily'] }], description: 'minutes per bar, 1 to 60, or "daily"' },
      count: { type: 'integer', minimum: 3, maximum: MAX_COUNT, description: 'How many bars (default: what the runner keeps; daily 60).' },
      record: RECORD,
      name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,23}$', description: 'A suffix for the file name (e.g. a role: trend), so a smaller fetch doesn\'t replace a file someone else is reading.' },
    }, ['symbol', 'timeframe']),
    args: i => ({
      symbol: i.symbol, timeframe: i.timeframe === 'daily' ? 3 : i.timeframe, daily: i.timeframe === 'daily', ...pick(i, { count: 'count' }), record: i.record === true,
      // A named file: the default one with the suffix, in the home's scratch directory (bars-fetch.js).
      ...(i.name ? { name: i.name } : {}),
    }),
    envFile: true,
    narrow: 'the reply is too large to return',
  },
  {
    name: 'combine_status', op: 'combine_status', script: 'combine',
    description: 'The prop challenge status: each started attempt\'s balance, floor, cushion, progress, size budget and whether entries are allowed, and the policy strategies\' live verdicts.',
    inputSchema: object({ account: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$', maxLength: 64, description: 'One account profile (default: every started attempt).' }, json: JSON_FLAG }),
    args: i => ({ ...pick(i, { account: 'account' }), json: i.json === true }),
    clockFirst: true,
    narrow: 'pass one account, or call it without json',
  },
  {
    name: 'lessons', op: 'lessons', script: 'lessons',
    description: 'What the journal has taught so far: the strongest instincts from reviewed trades and lessons.',
    inputSchema: object({ top: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many (default 10).' }, json: JSON_FLAG }),
    args: i => ({ ...pick(i, { top: 'top' }), json: i.json === true }),
    narrow: 'lower top, or call it without json',
  },
  {
    name: 'reconcile', op: 'reconcile', script: 'reconcile',
    description: 'Live against the scan for one trading day: which strategy signals the runner saw were traded, passed (and why), and which entries had no signal.',
    inputSchema: object({
      day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The trading day, YYYY-MM-DD (by the date it ends on).' },
      timeframe: { type: 'integer', minimum: 1, maximum: 1440, description: 'Minutes per bar (default 3).' },
      json: JSON_FLAG,
    }, ['day']),
    args: i => ({ day: i.day, ...pick(i, { timeframe: 'timeframe' }), json: i.json === true }),
    narrow: 'call it without json',
  },
  {
    name: 'bar_briefing', op: 'bar_briefing', script: 'briefing',
    description: 'The bar briefing the autonomous runner built after the last closed bar: the analysis by timeframe (m3: price, ET time and session window, regime, EMAs, ADX, VWAP side, participation, where price is against the value areas and IB, the scan\'s candidates, the trend rule; m15: the 15m read, alignment per side, today so far, the session profile; h1: the 1h and 4h reads; day: the prior RTH day, its profile, the overnight range). Each part has a version and holds until its timeframe\'s next close or a close through one of its levels: reuse it instead of recomputing; read the bars yourself only for what it lacks.',
    inputSchema: object({
      symbol: { type: 'string', pattern: '^[A-Z0-9]{1,8}(:\\d{4}-\\d{2})?$', description: 'A contract root (MNQ), or a contract by month (MNQ:2027-03): the root\'s briefing.' },
      timeframe: { type: 'string', pattern: '^[1-9]\\d*(m|h)$', description: 'An analyst\'s own timeframe ("15m", "1h"), when the caller gave you one: that timeframe\'s briefing (its bar part, valid until its next bar close, and the runner\'s parts it shares). Leave it out for the runner\'s bars.' },
      json: JSON_FLAG,
    }, ['symbol']),
    args: i => ({ symbol: i.symbol, json: i.json === true, ...pick(i, { timeframe: 'timeframe' }) }),
    narrow: 'call it without json',
  },
  {
    name: 'reason_check', op: 'reason_check', script: 'reason-check',
    description: 'Check the reasons you state for a decision (your CYCLE RESULT or VERDICT line, or the reasons alone) against the facts of the bar you decide: the bar briefing (the session window and whether it allows entries, the trend rule per side, the candidates, the room in R against the room needed, the multi-timeframe read per side), the policy verdicts on that bar, and the started prop attempts. Returns each claim it recognizes as TRUE, FALSE (with the fact) or UNCHECKED, the clauses that are your judgment or that it can\'t read, and each setup\'s priority-order steps as the facts answer them. Read-only; it decides nothing.',
    inputSchema: object({
      symbol: SYMBOL,
      reasons: { type: 'string', minLength: 1, maxLength: 2000, description: 'The decision and the reasons you stated, e.g. "CYCLE RESULT: no-trade - opening print window until 10:00 ET".' },
      json: JSON_FLAG,
    }, ['symbol', 'reasons']),
    args: i => ({ symbol: i.symbol, reasons: i.reasons, json: i.json === true }),
    clockFirst: true,
    narrow: 'call it without json',
  },
  {
    name: 'skill_lookup', op: 'skill_lookup', script: 'skill-lookup',
    description: 'A whole skill of the harness by name: one your prompt\'s skill index lists. Look one up only when the cycle needs it. Give role (your role\'s name) in a trading cycle: where the bar requires a skill of your index, your report counts for an entry only with that lookup. Read-only.',
    inputSchema: object({
      skill: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'The skill\'s name, e.g. fair-value-gaps.' },
      role: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'Your role\'s name, e.g. volume-liquidity-analyst.' },
    }, ['skill']),
    args: i => pick(i, { skill: 'skill', role: 'role' }),
    narrow: 'the skill is too large to return',
  },
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** The tools/list entries. */
const listTools = () => TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

module.exports = { SERVER_NAME, TOOLS, BY_NAME, listTools };
