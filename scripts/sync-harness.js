#!/usr/bin/env node
/**
 * Regenerate the Codex, Qwen, and workspace files from agents/, commands/,
 * rules/, and skills/.
 *
 *   node scripts/sync-harness.js          write
 *   node scripts/sync-harness.js --check  exit 1 if anything is stale (CI)
 */

'use strict';

const path = require('path');
const { syncHarness } = require('./lib/harness-sync');

const check = process.argv.includes('--check');
const stale = syncHarness(path.resolve(__dirname, '..'), { check });
if (stale.length === 0) {
  process.stdout.write('harness files are up to date\n');
} else if (check) {
  process.stderr.write(`stale generated files (run node scripts/sync-harness.js):\n${stale.map(s => `  ${s}`).join('\n')}\n`);
  process.exit(1);
} else {
  process.stdout.write(`updated:\n${stale.map(s => `  ${s}`).join('\n')}\n`);
}
