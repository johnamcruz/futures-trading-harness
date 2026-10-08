#!/usr/bin/env node
/**
 * Install the harness for one or more harnesses (install targets).
 *
 *   node scripts/install.js --target claude|codex|qwen|all --projectx /abs/projectx-mcp/dist/index.js [--dry-run]
 *
 * claude: copies rules/trading to ~/.claude/rules/trading and prints the plugin
 *         and MCP commands.
 * codex:  writes a marked block to ~/.codex/config.toml (projectx MCP behind the
 *         order gateway, agent roles) and prints the plugin commands.
 * qwen:   merges hooks and the projectx MCP server into ~/.qwen/settings.json and
 *         prints the extension command.
 * Existing files are backed up to <file>.fth-backup before writing.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TARGETS, applyPlan } = require('./lib/install');

function parseArgs(argv) {
  const get = name => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const target = get('--target');
  const projectx = get('--projectx') || process.env.PROJECTX_MCP_ENTRY;
  const targets = target === 'all' ? Object.keys(TARGETS) : String(target || '').split(',').filter(Boolean);
  if (targets.length === 0 || targets.some(t => !TARGETS[t])) {
    throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}, or all`);
  }
  if (!projectx) throw new Error('--projectx <path to projectx-mcp dist/index.js> is required (or set PROJECTX_MCP_ENTRY)');
  return { targets, projectxEntry: path.resolve(projectx), dryRun: argv.includes('--dry-run'), home: get('--home') || os.homedir() };
}

function main() {
  try {
    const { targets, projectxEntry, dryRun, home } = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(projectxEntry)) process.stderr.write(`warning: ${projectxEntry} does not exist yet (build projectx-mcp first)\n`);
    const root = path.resolve(__dirname, '..');
    for (const t of targets) {
      const plan = TARGETS[t]({ root, home, projectxEntry });
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
