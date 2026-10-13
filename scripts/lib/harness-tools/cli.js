'use strict';

/**
 * What the harness-tools operations share, and the thin CLI runner around them.
 *
 * An operation is `(args, { env, now, root }) -> { text, stderr?, code? }`:
 *   args   the operation's own arguments (an object; the CLIs parse argv into it)
 *   env    the environment it reads (process.env in the CLIs)
 *   now    () => Date: the harness clock (trading/harness-now.js harnessNow(env)
 *          by default), called where the operation reads the time
 *   root   the plugin root (strategies/, accounts/)
 *   replayAt  () => Date | null: the replay clock when one is in force (harness-now.js replayAt(env)
 *          by default; null live): no bar an operation reads may close after it (atClock)
 * It returns what the CLI prints: `text` on stdout, `stderr` (notes such as
 * "recorded for the order gate"), and `code` (the exit code, 0 by default).
 * A failure throws; an OpError also carries the stdout printed before it
 * (`text`), as the CLIs print a scan and then refuse to record it.
 */

const path = require('path');
const { harnessNow, replayAt: replayClockAt } = require('../trading/harness-now');
const { refuseAfterClock } = require('../trading/look-ahead');

const ROOT = path.resolve(__dirname, '..', '..', '..');

class OpError extends Error {
  constructor(message, text = '') {
    super(message);
    this.text = text;
  }
}

/**
 * The context an operation runs in, with defaults: process.env, the harness clock, the plugin root.
 * `tool`: the call came through the harness MCP server, so messages name the tool's arguments
 * (`record`, `symbol`) rather than the script's flags (`--record`, `--symbol`): say(c, cli, tool).
 * `barsEnv`: the environment the bars tools resolve their directories from (the server's own, before
 * any .env load), so bars_fetch writes where market_snapshot and the rest read; default `env`.
 */
function context({ env = process.env, barsEnv = env, now, replayAt, root = ROOT, tool = false } = {}) {
  return {
    env, barsEnv, root, tool: tool === true,
    now: typeof now === 'function' ? now : () => harnessNow(env),
    replayAt: typeof replayAt === 'function' ? replayAt : () => replayClockAt(env),
  };
}

/**
 * The bars an operation read from `file`, refused when a replay clock is in force and any of them
 * closes after it (no look-ahead: trading/look-ahead.js); live, the bars unchanged.
 */
function atClock(c, bars, file, label = 'the bars file') {
  return refuseAfterClock(bars, c.replayAt(), { what: `${label} ${file === '-' ? '(stdin)' : file}` });
}

/** The script's wording or the tool's, for the caller in front of it. */
const say = (c, cli, tool) => (c.tool ? tool : cli);

/**
 * A record request in an autonomous run (FTH_AUTONOMOUS=1): ignored, never honoured (the runner
 * writes the order gate's records itself, so the model can't), and not a failure either: the
 * operation returns its result with this note (`[tag] note: record ignored - why`). null otherwise.
 */
function ignoredRecord(c, tag, why) {
  if (c.env.FTH_AUTONOMOUS !== '1') return null;
  return `[${tag}] note: ${say(c, '--record', 'record')} ignored - ${why}\n`;
}

/** Run fn(); a failure becomes an OpError that keeps `text` (the stdout printed before it). */
function withText(text, fn) {
  try {
    return fn();
  } catch (err) {
    throw new OpError(err.message, `${text}${(err instanceof OpError && err.text) || ''}`);
  }
}

async function withTextAsync(text, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new OpError(err.message, `${text}${(err instanceof OpError && err.text) || ''}`);
  }
}

/** --name value or --name=value; every other flag is an error, so a typo can't be ignored silently. */
function options(args, valueFlags, boolFlags) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (valueFlags.includes(flag)) o[flag] = inline !== undefined ? inline : args[++i];
    else if (boolFlags.includes(flag) && inline === undefined) o[flag] = true;
    else if (!args[i].startsWith('--')) o._.push(args[i]);
    else throw new Error(`unknown argument: ${args[i]} (flags: ${[...valueFlags, ...boolFlags].join(' ')})`);
  }
  return o;
}

/**
 * The CLI around an operation: print its result and set the exit code. A
 * failure prints the stdout it carries, then `[tag] message` on stderr, exit 1.
 */
async function runCli(tag, fn, { stdout = process.stdout, stderr = process.stderr, proc = process } = {}) {
  try {
    const r = await fn();
    if (r.text) stdout.write(r.text);
    if (r.stderr) stderr.write(r.stderr);
    proc.exitCode = r.code || 0;
  } catch (err) {
    if (err instanceof OpError && err.text) stdout.write(err.text);
    stderr.write(`[${tag}] ${err.message}\n`);
    proc.exitCode = 1;
  }
}

module.exports = { ROOT, OpError, context, atClock, say, ignoredRecord, withText, withTextAsync, options, runCli };
