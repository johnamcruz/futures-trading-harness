#!/usr/bin/env node
/**
 * Runs a hook script only when enabled by the hook profile flags.
 *
 * Usage: node run-with-flags.js <hookId> <scriptRelativePath> [profilesCsv]
 *
 * The hook script must export `run(rawInput, ctx)` returning either a string
 * (written to stdout, exit 0) or { stdout?, stderr?, exitCode? }. Exit code 2
 * blocks the tool call and shows stderr to Claude.
 *
 * Hooks in FAIL_CLOSED_HOOKS gate real orders: if they can't inspect the full
 * input or they crash, the order is blocked instead of let through.
 */

'use strict';

require('../lib/sim-clock').installSimClock(process.env);

const fs = require('fs');
const path = require('path');
const { isHookEnabled, isDryRun } = require('../lib/hook-flags');
const { readStdinRaw, resolveMaxStdin } = require('./hook-input');

const FAIL_CLOSED_HOOKS = new Set(['pre:trading:order-gate']);

const MAX_STDIN = resolveMaxStdin(process.env.FTH_HOOK_INPUT_MAX_BYTES, {
  writeDiagnostic: message => process.stderr.write(message),
});

/** Exit only after stdout/stderr drain, so large outputs are not cut off. */
function exitWith(stdout, exitCode) {
  process.exitCode = exitCode;
  let pending = 1;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(exitCode);
  };
  if (stdout) {
    pending += 1;
    process.stdout.write(stdout, done);
  }
  process.stderr.write('', done);
}

function writeStderr(text) {
  if (typeof text === 'string' && text.length > 0) {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  }
}

function failClosed(hookId, reason) {
  writeStderr(`Blocked by trading harness: ${hookId} could not run (${reason}). `
    + 'The order was not sent. Fix the hook problem or disable the hook explicitly.');
  exitWith('', 2);
}

function getPluginRoot() {
  const fromEnv = String(process.env.CLAUDE_PLUGIN_ROOT || '').trim();
  return fromEnv || path.resolve(__dirname, '..', '..');
}

async function main() {
  const [, , hookId, relScriptPath, profilesCsv] = process.argv;
  const { raw, truncated } = await readStdinRaw(process.stdin, { maxStdin: MAX_STDIN });
  const failsClosed = FAIL_CLOSED_HOOKS.has(hookId);

  if (!hookId || !relScriptPath) return exitWith('', 0);
  // Order-gating hooks can't be dry-run, and in autonomous runs (FTH_AUTONOMOUS=1,
  // set by the runner for the harness it launches) they can't be disabled either.
  const locked = failsClosed && process.env.FTH_AUTONOMOUS === '1';
  if (!locked && !isHookEnabled(hookId, { profiles: profilesCsv })) return exitWith('', 0);
  if (isDryRun() && !failsClosed) {
    writeStderr(`[DryRun] Hook "${hookId}" would execute: ${relScriptPath}`);
    return exitWith('', 0);
  }

  const root = path.resolve(getPluginRoot());
  const scriptPath = path.resolve(root, relScriptPath);
  if (!scriptPath.startsWith(root + path.sep) || !fs.existsSync(scriptPath)) {
    if (failsClosed) return failClosed(hookId, `script not found: ${relScriptPath}`);
    writeStderr(`[Hook] Script not found for ${hookId}: ${scriptPath}`);
    return exitWith('', 0);
  }

  if (truncated && failsClosed) {
    return failClosed(hookId, `input exceeded ${MAX_STDIN} bytes`);
  }

  let output;
  try {
    const hook = require(scriptPath);
    if (typeof hook.run !== 'function') throw new Error('hook does not export run()');
    output = await hook.run(truncated ? '' : raw, { hookId, pluginRoot: root, truncated });
  } catch (err) {
    if (failsClosed) return failClosed(hookId, err.message);
    writeStderr(`[Hook] ${hookId} error: ${err.message}`);
    return exitWith('', 0);
  }

  if (typeof output === 'string') return exitWith(output, 0);
  if (output && typeof output === 'object') {
    writeStderr(output.stderr);
    const exitCode = Number.isInteger(output.exitCode) ? output.exitCode : 0;
    return exitWith(String(output.stdout ?? ''), exitCode);
  }
  return exitWith('', 0);
}

main().catch(err => {
  process.stderr.write(`[Hook] run-with-flags error: ${err.message}\n`);
  process.exit(FAIL_CLOSED_HOOKS.has(process.argv[2]) ? 2 : 0);
});
