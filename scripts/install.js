#!/usr/bin/env node
/**
 * Install the harness for one or more harnesses (install targets).
 *
 *   node scripts/install.js --target claude|codex|qwen|all [--broker <name>] [--entry /abs/<server>/dist/index.js] [--dry-run]
 *
 * The broker MCP server is the one in the broker config (mcp-configs/brokers.json,
 * yours in ~/.futures-trading-harness/brokers.json); --entry records its entry
 * script there, --broker picks which one (default: the configured broker).
 *
 * claude: copies rules/trading to ~/.claude/rules/trading and prints the plugin
 *         and MCP commands.
 * codex:  writes a marked block to ~/.codex/config.toml (the broker MCP behind the
 *         order gateway, agent roles) and prints the plugin commands.
 * qwen:   adds the broker MCP server (behind the gateway) to ~/.qwen/settings.json,
 *         removes old harness hooks there (the extension provides them), writes
 *         workspace/.qwen/settings.json (the autonomous allowlist), and prints
 *         the extension command.
 * Existing files are backed up to <file>.fth-backup before writing.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TARGETS, applyPlan, planBrokerEntry } = require('./lib/install');
const { activeBroker } = require('./lib/broker/config');
const { harnessHome } = require('./lib/paths');

function parseArgs(argv) {
  const get = name => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const target = get('--target');
  const entry = get('--entry');
  if (argv.includes('--projectx')) throw new Error('--projectx is gone: pass the broker MCP server\'s entry with --entry (and --broker <name> for a broker other than the default)');
  const targets = target === 'all' ? Object.keys(TARGETS) : String(target || '').split(',').filter(Boolean);
  if (targets.length === 0 || targets.some(t => !TARGETS[t])) {
    throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}, or all`);
  }
  return { targets, brokerName: get('--broker') || null, entry: entry ? path.resolve(entry) : null, dryRun: argv.includes('--dry-run'), home: get('--home') || os.homedir() };
}

function main() {
  try {
    const { targets, brokerName, entry, dryRun, home } = parseArgs(process.argv.slice(2));
    const env = { ...process.env, ...(brokerName ? { FTH_BROKER: brokerName } : {}) };
    const configured = activeBroker(env);
    const brokerFile = planBrokerEntry({ home, brokerName: configured.name, entry, stateDir: harnessHome(env, home) });
    if (brokerFile) {
      process.stdout.write(`${dryRun ? 'would write' : 'write'} ${brokerFile.file} (broker ${configured.name}: ${entry})\n`);
      if (!dryRun) applyPlan({ writes: [brokerFile] });
    }
    if (entry && !fs.existsSync(entry)) process.stderr.write(`warning: ${entry} does not exist yet (build the ${configured.name} MCP server first: ${configured.repo || 'its repo'})\n`);
    if (!entry && !configured.command) process.stderr.write(`warning: no MCP server set for broker ${configured.name}: pass --entry, or set ${configured.entryEnv || '"entry"'}\n`);
    const broker = activeBroker(env);
    const root = path.resolve(__dirname, '..');
    for (const t of targets) {
      const plan = TARGETS[t]({ root, home, broker });
      process.stdout.write(`\n== ${t} ==\n`);
      for (const w of plan.writes) process.stdout.write(`${dryRun ? 'would write' : 'write'} ${w.file}\n`);
      if (!dryRun) applyPlan(plan);
      process.stdout.write(`next:\n${plan.next.map(n => `  ${n}`).join('\n')}\n`);
    }
  } catch (err) {
    process.stderr.write(`[install] ${err.message}\n`);
    process.exit(1);
  }
}

main();
