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
 * No gate or check reads these blocks: the order gate, compose_check and the cycle checks recompute from the harness
 * home's own state, never from the prompt, so a block can't count for anything. The cycle log records what was given
 * (records: tool, args, asOf, sha256, chars; and what wasn't).
 *
 *   on(cfg)                     the key is on (harness claude, cycleDataInPrompt true)
 *   READS                       the broker reads collected, in prompt order
 *   briefingServed(env, symbol) { briefing, digest } when bar_briefing serves this cycle's bar's briefing, else { why }
 *   collect({ symbols, accountId, env, root, broker, now, callTool })   { blocks: [{ tool, args, asOf, text }], missing: [{ tool, args, why }] }
 *   render({ blocks, missing }) the prompt's data section ('' when there is nothing to say)
 *   records({ blocks })         [{ tool, args, asOf, sha256, chars }] for the cycle log
 *   failed(why)                 a collection that threw as a whole: no block, one line
 */

const crypto = require('crypto');
const { harnessHome } = require('./paths');
const { readBriefing } = require('./trading/briefing');
const { cycleBarOf } = require('./harness-tools/briefing');
const { briefingAfterClock } = require('./trading/look-ahead');
const { replayAt } = require('./trading/harness-now');

const REASON_CHARS = require('./tunables').runner().prompt.reasonChars; // config/runner.json prompt.reasonChars
const READS = Object.freeze(['get_account_snapshot', 'list_open_positions', 'list_open_orders']);
const BRIEFING = 'bar_briefing';

const on = cfg => Boolean(cfg) && cfg.harness === 'claude' && cfg.cycleDataInPrompt === true;
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
// A reason, as the prompt shows one: its first line, at most config/runner.json prompt.reasonChars.
const short = t => String(t || '').split('\n')[0].slice(0, REASON_CHARS);
const errText = err => short((err && err.message) || err);
const argsText = args => JSON.stringify(args);

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

async function briefingRead(symbol, { env, root, callTool }) {
  const args = { symbol };
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

async function brokerRead(tool, accountId, { broker, now }) {
  const args = { accountId };
  if (!broker || typeof broker.readText !== 'function') return { tool, args, why: 'the runner\'s broker client reads no raw text' };
  const asOf = now().toISOString();
  const res = await broker.readText(tool, args);
  if (!res || res.isError) return { tool, args, why: `the broker answered with an error (${short(res && res.text)})` };
  if (typeof res.text !== 'string') return { tool, args, why: 'the reply is not one text' };
  return { tool, args, asOf, text: res.text };
}

/**
 * Every read, in prompt order: each symbol's bar briefing, then the account's reads (none without an account). `env`:
 * the head trader's run's environment. A read that throws is a missing one; collect itself never throws.
 */
async function collect({ symbols = [], accountId = null, env, root, broker = null, now = () => new Date(), callTool = require('./harness-tools/protocol').callTool }) {
  const safe = (first, p) => p.catch(err => ({ ...first, why: `the read failed (${errText(err)})` }));
  const jobs = [...new Set(symbols.filter(Boolean))].map(s => safe({ tool: BRIEFING, args: { symbol: s } }, Promise.resolve().then(() => briefingRead(s, { env, root, callTool }))));
  if (Number.isInteger(accountId) && accountId >= 1) {
    for (const tool of READS) jobs.push(safe({ tool, args: { accountId } }, Promise.resolve().then(() => brokerRead(tool, accountId, { broker, now }))));
  }
  const done = await Promise.all(jobs);
  return { blocks: done.filter(x => typeof x.text === 'string'), missing: done.filter(x => typeof x.text !== 'string').map(({ tool, args, why }) => ({ tool, args, why })) };
}

const INTRO = 'This cycle\'s reads, already made: the runner called these tools for you just before your run, with your own tools\' settings, and each block below holds exactly the text the tool returned (its arguments and as-of time in its header). Take them as your own reads of those tools; call a tool again only for anything more, or for anything newer than its as-of time.';
const header = b => `--- ${b.tool} ${argsText(b.args)} as of ${b.asOf} ---`;
const footer = b => `--- end of ${b.tool} ${argsText(b.args)} (sha256 ${sha256(b.text)}) ---`;

/** The prompt's data section: the blocks, then a line for each read not made ('' with neither). */
function render({ blocks = [], missing = [], note = null } = {}) {
  if (!blocks.length && !missing.length && !note) return '';
  const lines = [`\n=== ${INTRO} ===`];
  for (const b of blocks) lines.push(header(b), b.text, footer(b));
  for (const m of missing) lines.push(`Not collected: ${m.tool} ${argsText(m.args)} (${m.why}); read it yourself if you need it.`);
  if (note) lines.push(note);
  lines.push('=== end of this cycle\'s reads ===\n');
  return lines.join('\n');
}

/** What the cycle log records of the blocks given. */
const records = ({ blocks = [] } = {}) => blocks.map(b => ({ tool: b.tool, args: b.args, asOf: b.asOf, sha256: sha256(b.text), chars: b.text.length }));

/** A collection that threw as a whole: no block, one line saying so. */
const failed = why => ({ blocks: [], missing: [], note: `The runner's reads for this cycle could not be made (${errText(why)}): make your reads yourself.` });

module.exports = { READS, BRIEFING, INTRO, on, sha256, briefingServed, onlyText, collect, render, records, failed };
