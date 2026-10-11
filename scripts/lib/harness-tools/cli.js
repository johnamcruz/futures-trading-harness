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
 * It returns what the CLI prints: `text` on stdout, `stderr` (notes such as
 * "recorded for the order gate"), and `code` (the exit code, 0 by default).
 * A failure throws; an OpError also carries the stdout printed before it
 * (`text`), as the CLIs print a scan and then refuse to record it.
 */

const path = require('path');
const { harnessNow } = require('../trading/harness-now');

const ROOT = path.resolve(__dirname, '..', '..', '..');

class OpError extends Error {
  constructor(message, text = '') {
    super(message);
    this.text = text;
  }
}

/** The context an operation runs in, with defaults: process.env, the harness clock, the plugin root. */
function context({ env = process.env, now, root = ROOT } = {}) {
  return { env, root, now: typeof now === 'function' ? now : () => harnessNow(env) };
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

module.exports = { ROOT, OpError, context, withText, withTextAsync, options, runCli };
